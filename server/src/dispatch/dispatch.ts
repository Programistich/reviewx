import { Octokit } from "@octokit/rest";
import {
  type AuthorPermission,
  buildFooter,
  createLeapingProgressComment,
  createRunStatusCheck,
  finalizeRunStatusCheck,
  LEAPING_INTO_ACTION_PREFIX,
  REVIEWX_REPO_URL,
  updateProgressComment,
} from "@reviewx/action/internal";
import type { Env } from "../env.ts";
import {
  createInstallationToken,
  findInstallationId,
  type GitHubApp,
  GitHubApiError,
  revokeInstallationToken,
} from "../github/app.ts";
import { buildPayload, runName } from "./payload.ts";
import type { Trigger } from "./triggers.ts";

export const WORKFLOW_FILE = "reviewx.yml";

export interface DispatchInput {
  owner: string;
  repo: string;
  defaultBranch: string;
  trigger: Trigger;
  sender: string;
}

export type DispatchResult =
  | { status: "dispatched"; runName: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

const DISPATCH_PERMISSIONS = {
  actions: "write",
  checks: "write",
  contents: "read",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

async function authorPermission(
  octokit: Octokit,
  params: { owner: string; repo: string; login: string }
): Promise<AuthorPermission> {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: params.owner,
      repo: params.repo,
      username: params.login,
    });
    const role = data.role_name ?? data.permission;
    if (
      role === "admin" ||
      role === "maintain" ||
      role === "write" ||
      role === "triage" ||
      role === "read"
    ) {
      return role;
    }
    return "none";
  } catch {
    return "none";
  }
}

function missingWorkflowBody(input: DispatchInput): string {
  return [
    `**ReviewX is installed on this repository, but it has no \`.github/workflows/${WORKFLOW_FILE}\` on \`${input.defaultBranch}\`.**`,
    "",
    "The app can't review anything until the workflow exists. Copy the template into the repo, add a model key as a GitHub Actions secret, and re-trigger.",
    "",
    `[Workflow template →](${REVIEWX_REPO_URL}/blob/main/templates/${WORKFLOW_FILE}) · [Setup guide →](${REVIEWX_REPO_URL}#setup)`,
  ].join("\n");
}

/**
 * Everything that happens after the webhook signature checks out and
 * `decideTrigger` said yes: mint a token, seed the progress comment and
 * check-run, build the payload, dispatch the workflow. On a dispatch failure
 * the seeded surfaces are rewritten with the reason so nothing strands.
 */
export async function dispatchRun(env: Env, input: DispatchInput): Promise<DispatchResult> {
  const app: GitHubApp = { appId: env.appId, privateKey: env.appPrivateKey };
  const installationId = await findInstallationId(app, input.owner, input.repo);
  if (installationId === null) {
    return { status: "skipped", reason: "app not installed on this repository" };
  }

  const minted = await createInstallationToken(app, {
    installationId,
    repositories: [input.repo],
    permissions: DISPATCH_PERMISSIONS,
  });
  const octokit = new Octokit({ auth: minted.token, userAgent: "reviewx-server" });
  const apiCtx = { octokit, owner: input.owner, repo: input.repo };

  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.trigger.number,
    });
    if (pr.state !== "open") return { status: "skipped", reason: "pull request not open" };

    const permission = await authorPermission(octokit, {
      owner: input.owner,
      repo: input.repo,
      login: input.sender,
    });

    // silent re-reviews post no "working…" comment; the review is the output.
    const silent = input.trigger.trigger === "pull_request_synchronize";
    const footer = buildFooter({});
    let progress: { id: number; type: "issue" | "review" } | undefined;
    if (!silent) {
      const target =
        input.trigger.kind === "review_comment"
          ? {
              kind: "reviewReply" as const,
              pullNumber: input.trigger.number,
              replyToCommentId: input.trigger.commentId,
            }
          : { kind: "issue" as const, issueNumber: input.trigger.number };
      const created = await createLeapingProgressComment(
        apiCtx,
        target,
        `${LEAPING_INTO_ACTION_PREFIX}...${footer}`
      );
      progress = created.comment;
    }

    const checkRunId = await createRunStatusCheck({
      octokit,
      owner: input.owner,
      repo: input.repo,
      headSha: pr.head.sha,
      detailsUrl: undefined,
    });

    const payload = buildPayload({
      trigger: input.trigger,
      pr: { title: pr.title, body: pr.body, headRef: pr.head.ref, headSha: pr.head.sha },
      triggerer: input.sender,
      authorPermission: permission,
      progressComment: progress,
      checkRunId,
    });
    const name = runName(input.trigger);

    try {
      await octokit.rest.actions.createWorkflowDispatch({
        owner: input.owner,
        repo: input.repo,
        workflow_id: WORKFLOW_FILE,
        ref: input.defaultBranch,
        inputs: { prompt: JSON.stringify(payload), name },
      });
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status: unknown }).status)
          : 0;
      const reason =
        status === 404 || status === 422
          ? `workflow ${WORKFLOW_FILE} not found on ${input.defaultBranch}`
          : `workflow dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
      const body =
        status === 404 || status === 422
          ? missingWorkflowBody(input)
          : `**ReviewX could not start a run.** ${reason}`;
      if (progress) {
        await updateProgressComment(apiCtx, progress, `${body}${footer}`).catch(() => undefined);
      } else {
        await octokit.rest.issues
          .createComment({
            owner: input.owner,
            repo: input.repo,
            issue_number: input.trigger.number,
            body: `${body}${footer}`,
          })
          .catch(() => undefined);
      }
      if (checkRunId !== undefined) {
        await finalizeRunStatusCheck({
          octokit,
          owner: input.owner,
          repo: input.repo,
          checkRunId,
          conclusion: "failure",
          detailsUrl: undefined,
          note: reason,
        }).catch(() => undefined);
      }
      return { status: "failed", reason };
    }

    return { status: "dispatched", runName: name };
  } catch (error) {
    if (error instanceof GitHubApiError) {
      return { status: "failed", reason: error.message };
    }
    throw error;
  } finally {
    await revokeInstallationToken(minted.token);
  }
}
