import type {
  IssueCommentCreatedEvent,
  PullRequestOpenedEvent,
  PullRequestReadyForReviewEvent,
  PullRequestReviewCommentCreatedEvent,
  PullRequestSynchronizeEvent,
  WebhookEvent,
} from "@octokit/webhooks-types";
import { hasMention, stripMention } from "./mention.ts";

export const REVIEW_INSTRUCTIONS = "Review this pull request.";
export const INCREMENTAL_REVIEW_INSTRUCTIONS =
  "New commits were pushed since the last review. Incrementally re-review the new commits on this pull request. Use the IncrementalReview mode.";

/** what the webhook asks the action to do, before any GitHub API call. */
export type Trigger =
  | {
      kind: "pull_request";
      trigger: "pull_request_opened" | "pull_request_ready_for_review";
      number: number;
      eventInstructions: string;
    }
  | {
      kind: "pull_request";
      trigger: "pull_request_synchronize";
      number: number;
      beforeSha: string;
      eventInstructions: string;
    }
  | {
      kind: "issue_comment";
      trigger: "issue_comment_created";
      number: number;
      commentId: number;
      /** the request with the mention removed; empty means "review this PR" */
      prompt: string;
    }
  | {
      kind: "review_comment";
      trigger: "pull_request_review_comment_created";
      number: number;
      commentId: number;
      prompt: string;
    };

export type TriggerDecision =
  | { run: true; trigger: Trigger; sender: string }
  | { run: false; reason: string };

type Ctx = { appSlug: string; botLogin: string };

function isBot(login: string | undefined, ctx: Ctx): boolean {
  if (!login) return false;
  const normalized = login.toLowerCase();
  return (
    normalized === ctx.botLogin.toLowerCase() ||
    normalized === `${ctx.appSlug.toLowerCase()}[bot]` ||
    normalized === ctx.appSlug.toLowerCase()
  );
}

/**
 * Decide whether a webhook delivery should start a run, and which one.
 * Pure: no network, no secrets. Everything that needs GitHub (author
 * permission, default branch) happens in `dispatch.ts`.
 */
export function decideTrigger(
  eventName: string,
  payload: WebhookEvent,
  ctx: Ctx
): TriggerDecision {
  const sender = "sender" in payload ? payload.sender?.login : undefined;
  if (isBot(sender, ctx)) return { run: false, reason: "event sent by the bot itself" };

  switch (eventName) {
    case "pull_request": {
      const action = (payload as { action?: string }).action;
      if (action !== "opened" && action !== "ready_for_review" && action !== "synchronize") {
        return { run: false, reason: `pull_request.${action} is not a review trigger` };
      }
      const pr = payload as
        | PullRequestOpenedEvent
        | PullRequestReadyForReviewEvent
        | PullRequestSynchronizeEvent;
      if (pr.pull_request.draft) return { run: false, reason: "draft pull request" };
      if (pr.pull_request.state !== "open") return { run: false, reason: "pull request not open" };
      if (isBot(pr.pull_request.user?.login, ctx)) {
        return { run: false, reason: "pull request authored by the bot" };
      }
      if (pr.action === "synchronize") {
        return {
          run: true,
          sender: sender ?? pr.pull_request.user.login,
          trigger: {
            kind: "pull_request",
            trigger: "pull_request_synchronize",
            number: pr.number,
            beforeSha: pr.before,
            eventInstructions: INCREMENTAL_REVIEW_INSTRUCTIONS,
          },
        };
      }
      return {
        run: true,
        sender: sender ?? pr.pull_request.user.login,
        trigger: {
          kind: "pull_request",
          trigger: pr.action === "opened" ? "pull_request_opened" : "pull_request_ready_for_review",
          number: pr.number,
          eventInstructions: REVIEW_INSTRUCTIONS,
        },
      };
    }

    case "issue_comment": {
      const ev = payload as IssueCommentCreatedEvent;
      if (ev.action !== "created") return { run: false, reason: "comment not created" };
      if (!ev.issue.pull_request) return { run: false, reason: "comment is on an issue, not a PR" };
      if (isBot(ev.comment.user?.login, ctx)) return { run: false, reason: "comment by the bot" };
      if (!hasMention(ev.comment.body, ctx.appSlug)) return { run: false, reason: "no mention" };
      return {
        run: true,
        sender: ev.comment.user.login,
        trigger: {
          kind: "issue_comment",
          trigger: "issue_comment_created",
          number: ev.issue.number,
          commentId: ev.comment.id,
          prompt: stripMention(ev.comment.body, ctx.appSlug),
        },
      };
    }

    case "pull_request_review_comment": {
      const ev = payload as PullRequestReviewCommentCreatedEvent;
      if (ev.action !== "created") return { run: false, reason: "comment not created" };
      if (isBot(ev.comment.user?.login, ctx)) return { run: false, reason: "comment by the bot" };
      if (!hasMention(ev.comment.body, ctx.appSlug)) return { run: false, reason: "no mention" };
      return {
        run: true,
        sender: ev.comment.user.login,
        trigger: {
          kind: "review_comment",
          trigger: "pull_request_review_comment_created",
          number: ev.pull_request.number,
          commentId: ev.comment.id,
          prompt: stripMention(ev.comment.body, ctx.appSlug),
        },
      };
    }

    default:
      return { run: false, reason: `event ${eventName} is not handled` };
  }
}
