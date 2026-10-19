import type { PushPermission, ShellPermission } from "../external.ts";

export interface Mode {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export interface RepoSettings {
  model: string | null;
  // reasoning-effort position on [0,1], landed on the running model's own
  // published ladder at resolve time. see action/effort.ts.
  effort: number | null;
  modes: Mode[];
  setupScript: string | null;
  postCheckoutScript: string | null;
  prepushScript: string | null;
  stopScript: string | null;
  push: PushPermission;
  shell: ShellPermission;
  prApproveEnabled: boolean;
  // "Include draft PRs": the post-run safety net re-reviews a moved draft only when set.
  reviewDrafts: boolean;
  // commits are created via the GitHub API (server-side signed, Verified)
  // instead of local git commit + push_branch. see CommitChangesTool.
  signedCommits: boolean;
  // false suppresses the live task-list updates. see mcp/comment.ts reportProgress.
  progressComments: boolean;
  // false suppresses the run-lifecycle check-run. see utils/runStatusCheck.ts.
  statusChecks: boolean;
  // true posts the approval verdict check. off by default — it is a merge
  // gate, so it must never turn itself on.
  approvalCheck: boolean;
  // standing instructions applied to every run, below the task in precedence.
  baseInstructions: string | null;
  modeInstructions: Record<string, string>;
  envAllowlist: string | null;
}

export const defaultSettings: RepoSettings = {
  model: null,
  effort: null,
  modes: [],
  setupScript: null,
  postCheckoutScript: null,
  prepushScript: null,
  stopScript: null,
  push: "restricted",
  shell: "restricted",
  prApproveEnabled: false,
  reviewDrafts: false,
  signedCommits: false,
  progressComments: true,
  statusChecks: true,
  approvalCheck: false,
  baseInstructions: null,
  modeInstructions: {},
  envAllowlist: null,
};
