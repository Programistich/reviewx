import type { AuthorPermission, PayloadEvent, WriteablePayload } from "@reviewx/action/internal";
import actionPackage from "@reviewx/action/package.json" with { type: "json" };
import type { Trigger } from "./triggers.ts";

export const ACTION_VERSION: string = actionPackage.version;

export interface PullRequestFacts {
  title: string;
  body: string | null;
  headRef: string;
  headSha: string;
}

export interface BuildPayloadInput {
  trigger: Trigger;
  pr: PullRequestFacts;
  triggerer: string;
  authorPermission: AuthorPermission;
  progressComment: { id: number; type: "issue" | "review" } | undefined;
  checkRunId: number | undefined;
}

/**
 * The JSON envelope the action parses out of its `prompt` input. Field names
 * and the `~reviewx` marker mirror `action/utils/payload.ts`; the event union
 * mirrors `action/external.ts`.
 */
export function buildPayload(input: BuildPayloadInput): WriteablePayload {
  const { trigger, pr } = input;
  const base = {
    issue_number: trigger.number,
    is_pr: true as const,
    title: pr.title,
    branch: pr.headRef,
    authorPermission: input.authorPermission,
  };

  let event: PayloadEvent;
  let prompt = "";
  let eventInstructions: string | undefined;

  switch (trigger.kind) {
    case "pull_request":
      eventInstructions = trigger.eventInstructions;
      if (trigger.trigger === "pull_request_synchronize") {
        event = {
          ...base,
          trigger: "pull_request_synchronize",
          body: pr.body,
          before_sha: trigger.beforeSha,
          // auto re-reviews post no progress chatter; the review itself is the output.
          silent: true,
        };
      } else {
        event = { ...base, trigger: trigger.trigger, body: pr.body };
      }
      break;
    case "issue_comment":
      prompt = trigger.prompt;
      if (!prompt) eventInstructions = "Review this pull request.";
      event = {
        ...base,
        trigger: "issue_comment_created",
        comment_type: "issue",
        comment_id: trigger.commentId,
        // the comment is the prompt; null keeps the action from quoting it twice.
        body: null,
      };
      break;
    case "review_comment":
      prompt = trigger.prompt;
      if (!prompt) eventInstructions = "Address this review comment.";
      event = {
        ...base,
        trigger: "pull_request_review_comment_created",
        comment_id: trigger.commentId,
        body: null,
      };
      break;
  }

  const payload: WriteablePayload = {
    "~reviewx": true,
    version: ACTION_VERSION,
    prompt,
    triggerer: input.triggerer,
    event,
  };
  if (eventInstructions) payload.eventInstructions = eventInstructions;
  if (input.progressComment) {
    payload.progressComment = {
      id: String(input.progressComment.id),
      type: input.progressComment.type,
    };
  }
  if (input.checkRunId !== undefined) payload.checkRun = { id: String(input.checkRunId) };
  return payload;
}

export function runName(trigger: Trigger): string {
  switch (trigger.trigger) {
    case "pull_request_opened":
    case "pull_request_ready_for_review":
      return `Review PR #${trigger.number}`;
    case "pull_request_synchronize":
      return `Re-review PR #${trigger.number}`;
    case "issue_comment_created":
    case "pull_request_review_comment_created":
      return `@reviewx-bot on PR #${trigger.number}`;
  }
}
