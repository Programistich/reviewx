import type { WebhookEvent } from "@octokit/webhooks-types";
import { describe, expect, it } from "vitest";
import { hasMention, stripMention } from "../src/dispatch/mention.ts";
import { buildPayload, runName } from "../src/dispatch/payload.ts";
import { decideTrigger } from "../src/dispatch/triggers.ts";

const ctx = { appSlug: "reviewx", botLogin: "reviewx[bot]" };

const user = (login: string) => ({ login, id: 1, type: "User" }) as never;
const repository = { name: "widget", owner: { login: "acme" }, default_branch: "main" } as never;

function pullRequestEvent(
  action: "opened" | "ready_for_review" | "synchronize" | "closed",
  overrides: Record<string, unknown> = {}
): WebhookEvent {
  return {
    action,
    number: 7,
    before: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    after: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    pull_request: {
      number: 7,
      state: "open",
      draft: false,
      title: "Add divide",
      body: "Adds division.",
      user: user("alice"),
      head: { ref: "feat/divide", sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      ...(overrides.pull_request as object),
    },
    repository,
    sender: user((overrides.sender as string) ?? "alice"),
  } as unknown as WebhookEvent;
}

function issueCommentEvent(body: string, overrides: Record<string, unknown> = {}): WebhookEvent {
  return {
    action: "created",
    issue: { number: 7, pull_request: { url: "x" }, ...(overrides.issue as object) },
    comment: { id: 555, body, user: user((overrides.author as string) ?? "bob") },
    repository,
    sender: user((overrides.author as string) ?? "bob"),
  } as unknown as WebhookEvent;
}

function reviewCommentEvent(body: string): WebhookEvent {
  return {
    action: "created",
    pull_request: { number: 7 },
    comment: { id: 777, body, user: user("carol") },
    repository,
    sender: user("carol"),
  } as unknown as WebhookEvent;
}

describe("decideTrigger: pull_request", () => {
  it("reviews an opened PR", () => {
    const d = decideTrigger("pull_request", pullRequestEvent("opened"), ctx);
    expect(d).toMatchObject({
      run: true,
      sender: "alice",
      trigger: { trigger: "pull_request_opened", number: 7 },
    });
  });

  it("reviews a PR marked ready for review", () => {
    const d = decideTrigger("pull_request", pullRequestEvent("ready_for_review"), ctx);
    expect(d).toMatchObject({ run: true, trigger: { trigger: "pull_request_ready_for_review" } });
  });

  it("re-reviews on synchronize with the before sha", () => {
    const d = decideTrigger("pull_request", pullRequestEvent("synchronize"), ctx);
    expect(d).toMatchObject({
      run: true,
      trigger: {
        trigger: "pull_request_synchronize",
        beforeSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
  });

  it("skips drafts, closed PRs, unrelated actions and the bot's own PRs", () => {
    expect(
      decideTrigger("pull_request", pullRequestEvent("opened", { pull_request: { draft: true } }), ctx)
    ).toMatchObject({ run: false, reason: "draft pull request" });
    expect(
      decideTrigger(
        "pull_request",
        pullRequestEvent("opened", { pull_request: { state: "closed" } }),
        ctx
      )
    ).toMatchObject({ run: false });
    expect(decideTrigger("pull_request", pullRequestEvent("closed"), ctx)).toMatchObject({
      run: false,
    });
    expect(
      decideTrigger(
        "pull_request",
        pullRequestEvent("opened", { pull_request: { user: user("reviewx[bot]") } }),
        ctx
      )
    ).toMatchObject({ run: false, reason: "pull request authored by the bot" });
    expect(
      decideTrigger("pull_request", pullRequestEvent("opened", { sender: "reviewx[bot]" }), ctx)
    ).toMatchObject({ run: false, reason: "event sent by the bot itself" });
  });
});

describe("decideTrigger: comments", () => {
  it("runs on an @reviewx mention in a PR comment and strips the mention", () => {
    const d = decideTrigger("issue_comment", issueCommentEvent("@reviewx explain src/math.ts"), ctx);
    expect(d).toMatchObject({
      run: true,
      sender: "bob",
      trigger: { trigger: "issue_comment_created", commentId: 555, prompt: "explain src/math.ts" },
    });
  });

  it("treats a bare mention as a review request", () => {
    const d = decideTrigger("issue_comment", issueCommentEvent("@ReviewX"), ctx);
    expect(d).toMatchObject({ run: true, trigger: { prompt: "" } });
  });

  it("ignores comments without a mention, on issues, or by the bot", () => {
    expect(decideTrigger("issue_comment", issueCommentEvent("looks good"), ctx)).toMatchObject({
      run: false,
      reason: "no mention",
    });
    expect(
      decideTrigger(
        "issue_comment",
        issueCommentEvent("@reviewx hi", { issue: { number: 7, pull_request: undefined } }),
        ctx
      )
    ).toMatchObject({ run: false, reason: "comment is on an issue, not a PR" });
    expect(
      decideTrigger("issue_comment", issueCommentEvent("@reviewx hi", { author: "reviewx[bot]" }), ctx)
    ).toMatchObject({ run: false });
  });

  it("runs on an @reviewx mention in a review thread", () => {
    const d = decideTrigger(
      "pull_request_review_comment",
      reviewCommentEvent("@reviewx is this safe?"),
      ctx
    );
    expect(d).toMatchObject({
      run: true,
      trigger: {
        trigger: "pull_request_review_comment_created",
        commentId: 777,
        prompt: "is this safe?",
      },
    });
  });

  it("ignores unrelated events", () => {
    expect(decideTrigger("push", {} as WebhookEvent, ctx)).toMatchObject({ run: false });
  });
});

describe("mention helpers", () => {
  it("matches only standalone mentions, case-insensitively", () => {
    expect(hasMention("@reviewx please", "reviewx")).toBe(true);
    expect(hasMention("hey @ReviewX,", "reviewx")).toBe(true);
    expect(hasMention("@reviewx-bot", "reviewx")).toBe(false);
    expect(hasMention("mail@reviewx.dev", "reviewx")).toBe(false);
    expect(hasMention(null, "reviewx")).toBe(false);
  });

  it("strips every mention and collapses whitespace", () => {
    expect(stripMention("@reviewx: fix this @reviewx please", "reviewx")).toBe("fix this please");
  });
});

describe("buildPayload", () => {
  const pr = { title: "Add divide", body: "Adds division.", headRef: "feat/divide", headSha: "b".repeat(40) };

  it("builds the opened-PR envelope the action expects", () => {
    const payload = buildPayload({
      trigger: {
        kind: "pull_request",
        trigger: "pull_request_opened",
        number: 7,
        eventInstructions: "Review this pull request.",
      },
      pr,
      triggerer: "alice",
      authorPermission: "write",
      progressComment: { id: 99, type: "issue" },
      checkRunId: 123,
    });
    expect(payload).toMatchObject({
      "~reviewx": true,
      prompt: "",
      triggerer: "alice",
      eventInstructions: "Review this pull request.",
      progressComment: { id: "99", type: "issue" },
      checkRun: { id: "123" },
      event: {
        trigger: "pull_request_opened",
        issue_number: 7,
        is_pr: true,
        title: "Add divide",
        body: "Adds division.",
        branch: "feat/divide",
        authorPermission: "write",
      },
    });
    expect(typeof payload.version).toBe("string");
  });

  it("marks synchronize runs silent and carries before_sha", () => {
    const payload = buildPayload({
      trigger: {
        kind: "pull_request",
        trigger: "pull_request_synchronize",
        number: 7,
        beforeSha: "a".repeat(40),
        eventInstructions: "re-review",
      },
      pr,
      triggerer: "alice",
      authorPermission: "admin",
      progressComment: undefined,
      checkRunId: undefined,
    });
    expect(payload.event).toMatchObject({
      trigger: "pull_request_synchronize",
      before_sha: "a".repeat(40),
      silent: true,
    });
    expect(payload.progressComment).toBeUndefined();
    expect(payload.checkRun).toBeUndefined();
  });

  it("puts the stripped comment into prompt and falls back to a review request", () => {
    const withText = buildPayload({
      trigger: { kind: "issue_comment", trigger: "issue_comment_created", number: 7, commentId: 5, prompt: "explain" },
      pr,
      triggerer: "bob",
      authorPermission: "read",
      progressComment: undefined,
      checkRunId: undefined,
    });
    expect(withText.prompt).toBe("explain");
    expect(withText.eventInstructions).toBeUndefined();
    expect(withText.event).toMatchObject({ trigger: "issue_comment_created", comment_type: "issue", comment_id: 5, body: null });

    const bare = buildPayload({
      trigger: { kind: "issue_comment", trigger: "issue_comment_created", number: 7, commentId: 5, prompt: "" },
      pr,
      triggerer: "bob",
      authorPermission: "read",
      progressComment: undefined,
      checkRunId: undefined,
    });
    expect(bare.eventInstructions).toBe("Review this pull request.");
  });

  it("names runs by trigger", () => {
    expect(
      runName({ kind: "pull_request", trigger: "pull_request_opened", number: 7, eventInstructions: "" })
    ).toBe("Review PR #7");
    expect(
      runName({ kind: "issue_comment", trigger: "issue_comment_created", number: 7, commentId: 1, prompt: "" })
    ).toBe("@reviewx on PR #7");
  });
});
