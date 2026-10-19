// changes to tool permissions should be reflected in wiki/granular-tools.md

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detect } from "package-manager-detector";
import { agents } from "./agents/index.ts";
import { subagentDeniedToolNames } from "./agents/subagentToolGates.ts";
import { findDanglingPromptToolRefs } from "./external.ts";
import { reportProgress } from "./mcp/comment.ts";
import { startInstallation } from "./mcp/dependencies.ts";
import { startMcpHttpServer, type ToolContext } from "./mcp/server.ts";
import { getSandboxMethod } from "./mcp/shell.ts";
import { computeModes } from "./modes.ts";
import { initToolState, primaryRepoState } from "./toolState.ts";
import {
  type ActivityTimeout,
  AGENT_ACTIVITY_TIMEOUT_MS,
  createProcessOutputActivityTimeout,
  DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
} from "./utils/activity.ts";
import { resolveAgent, resolveModel } from "./utils/agent.ts";
import { buildRejectedCredentialError, validateAgentApiKey } from "./utils/apiKeys.ts";
import { resolveBody } from "./utils/body.ts";
import { log } from "./utils/cli.ts";
import { installCodexAuth, installXaiAuth, REVIEWX_DATA_DIR } from "./utils/codexHome.ts";
import { checkConfiguredCredentials } from "./utils/credentialFallback.ts";
import { recordDiffReadFromToolUse } from "./utils/diffCoverage.ts";
import { onExitSignal } from "./utils/exitHandler.ts";
import { resolveGit, setGitAuthServer } from "./utils/gitAuth.ts";
import { startGitAuthServer } from "./utils/gitAuthServer.ts";
import {
  createOctokit,
  type OidcCredentials,
  writeGitHubUsageSummaryToFile,
} from "./utils/github.ts";
import { resolveInstructions } from "./utils/instructions.ts";
import { describeSetupFailure, executeLifecycleHook } from "./utils/lifecycle.ts";
import { normalizeEnv, sanitizeSecret } from "./utils/normalizeEnv.ts";
import {
  captureAuthorizedModels,
  captureBaselineModels,
  getAuthorizedModels,
} from "./utils/openCodeModels.ts";
import {
  type ProvisionablePackageManager,
  packageManagerBinDir,
  provisionPackageManager,
  resolvePackageManagerSpec,
} from "./utils/packageManager.ts";
import { resolveOutputSchema, resolvePayload, resolvePromptInput } from "./utils/payload.ts";
import { handleAgentResult } from "./utils/run.ts";
import { resolveRunContextData } from "./utils/runContextData.ts";
import { renderRunError } from "./utils/runErrorRenderer.ts";
import {
  finalizeSuccessRun,
  persistRunArtifacts,
  writeRunErrorOutputs,
} from "./utils/runLifecycle.ts";
import { logRunStartup } from "./utils/runStartupLog.ts";
import { setEnvAllowlist } from "./utils/secrets.ts";
import { createTempDirectory, setupGit, wipeRunnerLeakSurface } from "./utils/setup.ts";
import { reportStatusChecks } from "./utils/statusChecks.ts";
import { killTrackedChildren } from "./utils/subprocess.ts";
import { resolveTimeoutMs, TIMEOUT_DISABLED } from "./utils/time.ts";
import { Timer } from "./utils/timer.ts";
import { createTodoTracker } from "./utils/todoTracking.ts";
import {
  getGitHubInstallationToken,
  getJobToken,
  getMcpTokenRefresh,
  resolveTokens,
} from "./utils/token.ts";
import {
  cleanupVertexCredentials,
  materializeVertexCredentials,
  type VertexCredentials,
} from "./utils/vertex.ts";
import { resolveRun } from "./utils/workflow.ts";
import { dirtyTrackedPaths, restoreDirtiedSince } from "./utils/worktree.ts";

export { Inputs } from "./utils/payload.ts";

export interface MainResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  result?: string | undefined;
}

export async function main(): Promise<MainResult> {
  // normalize env var names to uppercase (handles case-insensitive workflow files)
  normalizeEnv();

  // write usage summary on SIGINT/SIGTERM so the worker can read it after sandbox.exec
  const usageSummaryPath = process.env.REVIEWX_USAGE_SUMMARY_PATH;
  if (usageSummaryPath) {
    onExitSignal(() => writeGitHubUsageSummaryToFile(usageSummaryPath));
  }

  const timer = new Timer();
  let activityTimeout: ActivityTimeout | null = null;
  let safetyNetTimer: NodeJS.Timeout | undefined;

  // parse prompt early to extract progressComment for toolState
  const resolvedPromptInput = resolvePromptInput();

  // resolve and fingerprint git binary before any agent code runs
  resolveGit();

  // get job token for initial API calls
  const jobToken = getJobToken();
  const initialOctokit = createOctokit(jobToken);
  const runContext = await resolveRunContextData({ octokit: initialOctokit });
  timer.checkpoint("runContextData");

  const payload = resolvePayload(resolvedPromptInput, runContext.repoSettings);

  // seed toolState with the primary repo (keyed in `repos`). dir is the
  // run-entry cwd; configureRepoGit refreshes it after any payload.cwd chdir.
  const toolState = initToolState({
    progressComment:
      typeof resolvedPromptInput !== "string" ? resolvedPromptInput.progressComment : undefined,
    owner: runContext.repo.owner,
    name: runContext.repo.name,
    dir: process.cwd(),
  });
  toolState.model = payload.model;
  // seed the comment target before every terminal branch. `reportErrorToComment`
  // reads only toolState, so silent triggers otherwise have nowhere to post.
  if (payload.event.issue_number !== undefined) {
    primaryRepoState(toolState).issueNumber = payload.event.issue_number;
  }
  if (payload.event.trigger === "pull_request_synchronize") {
    primaryRepoState(toolState).beforeSha = payload.event.before_sha;
  }

  // stash OIDC credentials before any early return. refused runs need a scoped
  // comment token; normal runs reuse the snapshot after the restricted env wipe.
  const oidcCredentials: OidcCredentials | null =
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
      ? {
          requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
          requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        }
      : null;

  // tmpdir hoisted out of the try block: `installFromNpmTarball` reads
  // REVIEWX_TEMP_DIR (set as a side effect of createTempDirectory) when
  // the opencode CLI install runs below for BYOK introspection. agent +
  // mcp server setup further down also consume the same tmpdir.
  //
  // the return value is reused below rather than calling again: every call
  // `mkdtempSync`s a NEW directory and overwrites REVIEWX_TEMP_DIR, and the
  // installers key their fs cache off that variable *at call time* — so a
  // second call silently invalidated the cache and re-downloaded plus
  // re-extracted the whole opencode tarball on every run.
  //
  // `using` removes it only when main() returns, after both run-end paths
  // below have persisted the PR summary and learnings they read from here.
  using tempDir = createTempDirectory();
  const tmpdir = tempDir.path;

  // install OpenCode + capture the BASELINE model set BEFORE dbSecrets and
  // Codex auth.json are in scope. this is the set of models OpenCode can
  // route from the runner's pre-existing environment alone (workflow
  // `env:` block + GH Actions secrets). install is fs-cached, so the
  // duplicate call inside the opencode agent's run() is a no-op.
  //
  // one restore window straddling both `opencode models` captures (#1151):
  // nothing between them writes to the worktree, and both finish before any
  // agent tool exists, so the #1146 "don't discard the agent's own work" hazard
  // cannot apply.
  //
  // keyed on `payload.cwd`, NOT `process.cwd()`. that is the whole lesson of
  // 0.1.54: this code runs BEFORE the chdir below, and `runCli.ts` starts the
  // CLI outside the checkout (a bootstrap tmpdir, or an action checkout with no
  // `.git`), so reading `process.cwd()` here made git exit 129 and throw — every
  // customer run died before the agent started. with no repo dir resolved there
  // is nothing to protect, so the window simply does not open.
  const repoDir = payload.cwd;
  const preIntrospectionDirty = repoDir ? await dirtyTrackedPaths({ cwd: repoDir }) : null;
  const opencodeCliPath = await agents.opencode.install();
  captureBaselineModels({ cliPath: opencodeCliPath, tmpdir });

  // materialize the subscription auth.json entries from env (CODEX_AUTH_JSON,
  // GROK_AUTH_JSON). this has to land BEFORE captureAuthorizedModels so
  // OpenCode's model introspection sees the OAuth-routed models.
  installCodexAuth();
  installXaiAuth();

  // capture the AUTHORIZED model set after Codex auth.json is applied. this is the authoritative source for the BYOK fallback
  // decision and the opencode-agent path of validateAgentApiKey — strictly
  // more accurate than the static envVars/managedCredentials catalog,
  // which can miss new auth shapes.
  captureAuthorizedModels({ cliPath: opencodeCliPath, tmpdir });

  // close the window opened before the baseline capture.
  if (preIntrospectionDirty && repoDir) {
    await restoreDirtiedSince({
      before: preIntrospectionDirty,
      actor: "model introspection",
      cwd: repoDir,
    });
  }

  // configure env allowlist for subprocess filtering
  if (runContext.repoSettings.envAllowlist) {
    setEnvAllowlist(runContext.repoSettings.envAllowlist);
  }

  // resolve tokens first — acquireNewToken needs OIDC env vars for token exchange
  await using tokenRef = await resolveTokens({
    push: payload.push,
    authorPermission: payload.event.authorPermission,
    oidc: oidcCredentials,
  });

  // wipe the GHA runner's known credential leak surface inside $RUNNER_TEMP
  // before the agent spawns. our installation token is already in memory
  // (tokenRef above), and setupGit's includeIf strip handles the matching
  // dangling references in the user's .git/config. see wipeRunnerLeakSurface
  // for the leak inventory and threat model.
  wipeRunnerLeakSurface();

  // probe the sandbox ONCE, here, rather than lazily inside the first
  // `spawnShell`. on an unprivileged Kubernetes/ARC runner every PID-namespace
  // method fails, so every `reviewx_shell` call throws — but detection used to
  // happen minutes in, the tool stayed registered, and the prompt kept telling
  // the agent it was the only sanctioned way to run anything. 192 runs / 757
  // dead tool calls in 24h, all green, with agents submitting reviews whose
  // tests they had decided to run and could not (#1093). resolving it to
  // `disabled` up front makes the tool set and the prompt agree with reality,
  // and gives the operator one line they can act on.
  if (payload.shell !== "disabled" && process.env.CI === "true" && getSandboxMethod() === "none") {
    payload.shell = "disabled";
    log.warning(
      "» shell commands are disabled for this run: this runner provides no PID-namespace isolation " +
        "(unprivileged unshare, sudo unshare and userns-nested unshare all failed). " +
        "on a self-hosted Kubernetes/ARC runner, allow user-namespace creation in the pod's seccomp " +
        "profile — see https://github.com/programistich/reviewx#self-hosted-runners"
    );
  }

  // clear OIDC env vars in restricted mode to prevent agent from minting tokens
  if (payload.shell !== "enabled") {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }

  // create octokit with MCP token for GitHub API calls.
  // the refresh handles mid-run token invalidation (#891)
  const octokit = createOctokit(tokenRef.mcpToken, getMcpTokenRefresh());

  const runInfo = await resolveRun({ octokit });
  let toolContext: ToolContext | undefined;
  let progressCallbackDisabled = false;
  let todoTracker: ReturnType<typeof createTodoTracker> | undefined;
  let vertexCredentials: VertexCredentials | undefined;

  try {
    if (payload.cwd && process.cwd() !== payload.cwd) {
      process.chdir(payload.cwd);
    }

    // resolve body - fetches body_html and converts to markdown if images present
    // this ensures agents receive markdown with working signed image URLs
    const originalBody = payload.event.body;
    const resolvedBody = await resolveBody({
      event: payload.event,
      octokit,
      repo: runContext.repo,
      tmpdir,
      githubToken: tokenRef.mcpToken,
    });
    if (resolvedBody !== originalBody) {
      payload.event.body = resolvedBody;
      // also update prompt if original body was included there
      if (originalBody && payload.prompt.includes(originalBody)) {
        payload.prompt = payload.prompt.replace(originalBody, resolvedBody ?? "");
      }
    }

    await using gitAuthServer = await startGitAuthServer(tmpdir);
    setGitAuthServer(gitAuthServer);

    const resolvedModel = resolveModel({ slug: payload.model });

    // ask the providers whether the configured model's credentials still work
    // before committing to it. a rejected credential becomes an accurate error naming
    // the credential — never the 401-three-seconds-in that used to send users
    // to a GitHub Actions secrets page they had never put a key in.
    const credentials = await checkConfiguredCredentials({ model: resolvedModel });
    if (credentials.kind === "dead") {
      throw new Error(
        buildRejectedCredentialError({
          credential: credentials.credential,
          reason: credentials.reason,
          owner: runContext.repo.owner,
          name: runContext.repo.name,
        })
      );
    }
    vertexCredentials = materializeVertexCredentials({ model: resolvedModel });

    const agent = resolveAgent({ model: resolvedModel });

    // record the harness that actually ran. `agent` is what the run DID;
    // `WorkflowRun.codexArm` is what it was ASSIGNED — comparing arms on the
    // assignment is what keeps runs that die before this PATCH in the analysis.
    toolState.agent = agent.name;

    // agent-agnostic best-effort for the model that ran: the resolved model,
    // else the slug. the opencode agent refines this from `rawModel` once it
    // auto-selects (a pick main.ts can't know — see opencode.ts).
    const effectiveModel = resolvedModel ?? payload.model;
    // surface it in comment/review footers and persist it on the end-of-run PATCH.
    toolState.model = effectiveModel;

    // fail fast when the configured model needs a key the runner doesn't
    // have. the thrown markdown is mirrored by `renderRunError` →
    // `writeRunErrorOutputs` to both the PR/issue comment (when the run has
    // issue context) and the GHA job summary, with model-specific fix
    // instructions. Without this, the agent launches with no key, the LLM
    // provider 401s, and the run dies in seconds with a synthetic "Invalid
    // API key".
    validateAgentApiKey({
      agent,
      model: effectiveModel,
      authorized: getAuthorizedModels(),
      owner: runContext.repo.owner,
      name: runContext.repo.name,
    });

    await setupGit({
      gitToken: tokenRef.gitToken,
      owner: runContext.repo.owner,
      name: runContext.repo.name,
      octokit,
      toolState,
      shell: payload.shell,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
    });
    timer.checkpoint("git");

    // pin the project's package manager via corepack BEFORE the setup hook
    // runs. without this, a customer setup script like `npm i -g pnpm &&
    // pnpm install` installs whatever pnpm is "latest" today and writes
    // unrelated lockfile drift (e.g. the `packageManagerDependencies`
    // block pnpm 11.3 added) into our commit — see #844. resolution
    // honors pnpm 11+ precedence (`devEngines.packageManager` over
    // `packageManager`); failure is non-fatal — we fall back to whatever
    // is on PATH with a warning. the shim lands in a private bin dir
    // (prepended to PATH), not the node bin dir, so a setup `npm i -g pnpm`
    // can't collide with it.
    const pmSpec = await resolvePackageManagerSpec(process.cwd());
    // resolve the manager the same way the prep phase will (declared spec first,
    // then lockfile) and provision it by whatever route it needs. asking corepack
    // alone was the bug: it manages pnpm and yarn and ignores bun and deno, so a
    // `setup` hook running `bun install` died with `bun: command not found` 0.8s
    // before ReviewX installed bun itself. see #1121.
    const pmDetected = await detect({ cwd: process.cwd(), strategies: ["lockfile"] });
    const pmName = pmSpec?.name ?? (pmDetected?.name as ProvisionablePackageManager) ?? "npm";
    // provisioning executes code, so it is gated on shell exactly like the prep phase.
    if (payload.shell !== "disabled") {
      const pmError = await provisionPackageManager({
        name: pmName,
        declared: pmSpec,
        binDir: packageManagerBinDir(tmpdir),
      });
      if (pmError) log.warning(`» could not provision ${pmName}: ${pmError}`);
    }
    timer.checkpoint("packageManager");

    // execute the setup lifecycle hook (runs once at initialization). best-effort:
    // a failure no longer aborts the run — we warn the operator and surface it to
    // the agent via the SETUP HOOK FAILED banner so it can verify the env and adapt.
    const setupHook = await executeLifecycleHook({
      event: "setup",
      script: runContext.repoSettings.setupScript,
      shell: payload.shell,
      normalizeWorkingTreeAfter: true,
    });
    if (setupHook.warning) {
      log.warning(setupHook.warning);
    }
    timer.checkpoint("lifecycleHooks::setup");

    const agentId = agent.name;
    const modes = [...computeModes(agentId), ...runContext.repoSettings.modes];

    const outputSchema = resolveOutputSchema();

    // mcpServerUrl and tmpdir are set after server starts
    toolContext = {
      agentId,
      repo: runContext.repo,
      payload,
      octokit,
      // live getter so raw-token consumers (asset fetches, plan/summary-comment
      // GETs) see the refreshed MCP token after a mid-run re-acquisition (#891)
      get githubInstallationToken() {
        return getGitHubInstallationToken();
      },
      // live getter, same reason as #891 above — reads the current git token
      // (canonical rationale on TokenRef.gitToken). see #964.
      get gitToken() {
        return tokenRef.gitToken;
      },
      refreshGitToken: tokenRef.refreshGitToken,
      ghToken: tokenRef.ghToken,
      modes,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
      prepushScript: runContext.repoSettings.prepushScript,
      prApproveEnabled: runContext.repoSettings.prApproveEnabled,
      reviewDrafts: runContext.repoSettings.reviewDrafts,
      signedCommits: runContext.repoSettings.signedCommits,
      modeInstructions: runContext.repoSettings.modeInstructions,
      toolState,
      runId: runInfo.runId,
      jobId: runInfo.jobId,
      mcpServerUrl: "",
      tmpdir,
      resolvedModel,
    };
    await using mcpHttpServer = await startMcpHttpServer(toolContext, { outputSchema });
    toolContext.mcpServerUrl = mcpHttpServer.url;
    log.info(`» MCP server started at ${mcpHttpServer.url}`);
    timer.checkpoint("mcpServer");

    // derive the subagent deny list from the same tool set the server just
    // registered, so the gate can never drift from the registered tools.
    const subagentDeniedTools = subagentDeniedToolNames(toolContext, outputSchema);

    startInstallation(toolContext);

    logRunStartup({ payload, resolvedModel, agentName: agent.name });

    const instructions = resolveInstructions({
      payload,
      repo: runContext.repo,
      modes,
      agentId,
      outputSchema,
      signedCommits: runContext.repoSettings.signedCommits,
      setupHookFailure: describeSetupFailure(setupHook.failure),
    });
    // the prompt and the tool registry are decided in different files off
    // overlapping conditions; this is what stops them disagreeing silently.
    // WARNS, never throws: the prompt embeds customer-authored text (repo
    // instructions, an issue body), so a customer who merely writes a prefixed
    // token controls this predicate — throwing let them fail every run on their
    // own repo (`arcainc/arca`, 0.1.56).
    const danglingToolRefs = findDanglingPromptToolRefs({
      agentId,
      prompt: instructions.full,
      toolNames: mcpHttpServer.toolNames,
    });
    if (danglingToolRefs.length > 0) {
      log.warning(
        `» prompt advertises ${danglingToolRefs.length} tool(s) the MCP server did not register: ${danglingToolRefs.join(", ")}`
      );
    }
    const logParts = [
      instructions.eventInstructions
        ? `EVENT-LEVEL INSTRUCTIONS:\n${instructions.eventInstructions}`
        : null,
      instructions.user ? `USER REQUEST:\n${instructions.user}` : null,
      instructions.event,
    ].filter(Boolean);
    log.box(logParts.join("\n\n---\n\n"), {
      title: "Instructions",
    });
    log.group("View full prompt", () => {
      log.info(instructions.full);
    });

    // OpenCode loads .opencode/plugin/ files at startup. if the repo has any,
    // eagerly await dependency installation so plugin imports can resolve.
    if (agentId === "opencode") {
      const pluginDir = join(process.cwd(), ".opencode", "plugin");
      const hasPlugins =
        existsSync(pluginDir) && readdirSync(pluginDir).some((f) => /\.[jt]sx?$/.test(f));
      if (hasPlugins && toolState.dependencyInstallation?.promise) {
        log.info(
          "» .opencode/plugin/ detected — awaiting dependency installation before agent start"
        );
        await toolState.dependencyInstallation.promise.catch(() => {});
        timer.checkpoint("awaitDepsForPlugins");
      }
    }

    // run agent, optionally with timeout enforcement
    activityTimeout = createProcessOutputActivityTimeout({
      timeoutMs: AGENT_ACTIVITY_TIMEOUT_MS,
      checkIntervalMs: DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
    });
    activityTimeout.promise.catch(() => {}); // prevent unhandled rejection if agent wins race
    todoTracker = createTodoTracker(async (body) => {
      if (progressCallbackDisabled || !toolContext) return;
      try {
        // liveProgress: this is the auto-rendered checklist, not a deliberate
        // final answer — must not flip wasUpdated / lastProgressBody (see #868).
        await reportProgress(toolContext, { body, liveProgress: true });
      } catch (err) {
        log.debug(`progress update failed: ${err}`);
      }
    });
    toolState.todoTracker = todoTracker;

    // on cancellation, stop scheduling new tracker writes immediately. without this, a
    // debounced write queued just before SIGTERM could land at GitHub *after* the
    // workflow_run.completed webhook has already replaced the comment with the
    // "This run was cancelled" body, clobbering it back to the task list. we can't
    // await in-flight writes (the process is exiting), but cancelling the timer
    // shrinks the race window.
    onExitSignal(() => {
      todoTracker?.cancel();
    });

    // when the agent is killed for inner activity timeout, start a short
    // safety-net timer — if the agent promise hasn't resolved within 5min after
    // the inner kill, stop the MCP HTTP server (so mcp-proxy's SSE reconnect
    // attempts don't keep the outer activity timer alive) and force-reject the
    // outer timer so the run can exit.
    //
    // both were previously done the instant the watchdog fired, which is what
    // made the salvage in `opencode.ts` impossible: the re-prompt landed on a
    // dead MCP server, so the agent could not call `create_pull_request_review`
    // and the "recovery" produced a confidently toolless turn. deferring costs
    // nothing — `forceReject` ends the run directly, so it never depended on
    // the teardown, and `onTurnRecovered` cancels the whole thing the moment a
    // turn actually comes back. see #1085.
    let innerTimeoutFired = false;
    const onInnerActivityTimeout = () => {
      if (innerTimeoutFired) return;
      innerTimeoutFired = true;
      log.info("» inner activity timeout fired — starting 5min safety-net timer");
      safetyNetTimer = setTimeout(
        () => {
          // fire and forget — the server's dispose is idempotent so the
          // `await using` cleanup at block exit is still safe.
          mcpHttpServer[Symbol.asyncDispose]().catch((err) => {
            log.debug(
              `mcp server stop after inner kill failed: ${err instanceof Error ? err.message : String(err)}`
            );
          });
          activityTimeout?.forceReject(
            "agent still pending 5min after inner activity kill — forcing exit"
          );
        },
        5 * 60 * 1000
      );
      safetyNetTimer.unref?.();
    };

    // the aborted turn came back, so the harness is salvaging rather than dying.
    // the net only exists to catch an abort opencode ignored; leaving it armed
    // would force-exit a run that is legitimately working again. re-arming is
    // safe because the watchdog fires per turn. see #1085.
    const onTurnRecovered = () => {
      if (!innerTimeoutFired) return;
      innerTimeoutFired = false;
      if (safetyNetTimer) clearTimeout(safetyNetTimer);
      safetyNetTimer = undefined;
      // the one observable for this handshake, and the counterpart to the
      // `log.info` above. only reachable on a run that already stalled, so it
      // costs nothing on a healthy one — and without it, production `.logs/`
      // show the net armed and then nothing, leaving "stood down"
      // indistinguishable from "still counting, the run just ended". see #1085.
      log.info("» inner activity safety net stood down — turn recovered");
    };

    const agentPromise = agent.run({
      payload,
      resolvedModel,
      mcpServerUrl: mcpHttpServer.url,
      tmpdir,
      subagentDeniedTools,
      // REVIEWX_DATA_DIR (/var/lib/reviewx) holds codex auth.json + any
      // future reviewx-managed on-disk secrets. bash via MCP tmpfs-overlays
      // it; agent native FS tools deny it via the same secretDenyPaths plumbing
      // used for vertex creds. see wiki/security.md "Filesystem Sandbox".
      secretDenyPaths: [
        REVIEWX_DATA_DIR,
        ...(vertexCredentials ? [vertexCredentials.secretDir] : []),
      ],
      instructions,
      todoTracker,
      stopScript: runContext.repoSettings.stopScript,
      toolState,
      onActivityTimeout: onInnerActivityTimeout,
      onTurnRecovered,
      onToolUse: (event) => {
        const wasTracked = recordDiffReadFromToolUse({
          state: primaryRepoState(toolState).diffCoverage,
          toolName: event.toolName,
          input: event.input,
          cwd: process.cwd(),
        });
        if (!wasTracked) return;
        const trackedRanges = primaryRepoState(toolState).diffCoverage?.coveredRanges ?? [];
        log.debug(
          `» diff coverage tracked from tool ${event.toolName} (${trackedRanges.length} merged range${trackedRanges.length === 1 ? "" : "s"})`
        );
      },
    });
    // symmetric with the activityTimeout/timeoutPromise catches below: if a
    // timeout wins the race, agentPromise is stranded and its later rejection
    // becomes an unhandled rejection. node 15+ terminates the process on
    // unhandled rejection by default, which would kill main() mid-cleanup and
    // lose the error-reporting / usage-summary work that follows. the race
    // still sees the rejection (the original promise is shared); this catch
    // only keeps node from treating a post-race rejection as unobserved.
    agentPromise.catch(() => {});

    // timeout enforcement: default is 1 hour, but can be overridden via flags in the prompt:
    // - --timeout=2h (or any duration like "--timeout=30m", "--timeout=1h30m") to set a custom timeout
    // - --notimeout to disable timeout entirely
    let result: Awaited<typeof agentPromise>;
    if (payload.timeout === TIMEOUT_DISABLED) {
      result = await Promise.race([agentPromise, activityTimeout.promise]);
    } else {
      // resolveTimeoutMs rejects unparseable / zero / setTimeout-overflow inputs
      // so a bad string can't silently resolve to an instant timeout. fall back
      // to the 1h default with a warning — users who want runtime measured in
      // weeks should use --notimeout.
      const usable = resolveTimeoutMs(payload.timeout);
      if (payload.timeout && usable === null) {
        log.warning(`invalid timeout "${payload.timeout}" (use --notimeout to disable), using 1h`);
      }
      const timeoutMs = usable ?? 3600000;
      const actualTimeout = usable !== null ? payload.timeout : "1h";
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`agent run timed out after ${actualTimeout}`));
        }, timeoutMs);
      });
      timeoutPromise.catch(() => {}); // prevent unhandled rejection if agent wins race
      try {
        result = await Promise.race([agentPromise, timeoutPromise, activityTimeout.promise]);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // accumulate top-level agent usage
    if (result.usage) {
      toolState.usageEntries.push(result.usage);
    }

    // validate this before writing job summary to avoid masking the error
    if (outputSchema && !toolState.output) {
      throw new Error(
        "output_schema was provided but agent did not call set_output — structured output is required"
      );
    }

    // success-path cleanup: postReview → persistSummary → persistLearnings →
    // failure-error-report → stranded-comment cleanup → job summary → output
    // marker. each step is best-effort; see `finalizeSuccessRun` for ordering
    // rationale (notably: progress-comment deletion lives in
    // create_pull_request_review for review-mode runs, so deletion here
    // covers the non-review success paths).
    await finalizeSuccessRun({ toolContext, toolState, result, repo: runContext.repo });

    const outcome = await handleAgentResult({
      result,
      toolContext,
      silent: payload.event.silent ?? false,
    });
    return outcome;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown error occurred";
    progressCallbackDisabled = true;
    todoTracker?.cancel();
    killTrackedChildren();
    log.error(errorMessage);

    // classify (hang detection + API-key auth
    // detection) and render to {summary, comment} markdown bodies.
    const rendered = renderRunError({
      errorMessage,
      repo: runContext.repo,
      agentDiagnostic: toolState.agentDiagnostic,
    });
    await writeRunErrorOutputs({ rendered, toolState });

    // best-effort cleanup: review dispatch, summary persist, learnings persist.
    // a partial edit before the crash is still worth keeping.
    if (toolContext) {
      await persistRunArtifacts(toolContext);
      // failed/timed-out run → post `reviewx` = failure (and `reviewx-approval`
      // if a verdict landed before the crash). own best-effort guard internally.
      await reportStatusChecks(toolContext, { runSucceeded: false });
    }

    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    activityTimeout?.stop();
    if (safetyNetTimer) clearTimeout(safetyNetTimer);
    // also reap on the success-with-failure path (agent returned
    // `{success: false}`) which skips the catch above and would otherwise hang
    // ~60s on the eager dep install. idempotent SIGKILL. see #862.
    killTrackedChildren();
    if (usageSummaryPath) {
      // a write error here (ENOSPC, EACCES, dirname removed) must not mask
      // either the try's successful return or the catch's error return.
      // the summary is informational — log and move on.
      try {
        await writeGitHubUsageSummaryToFile(usageSummaryPath);
      } catch (err) {
        log.debug(
          `failed to write usage summary to ${usageSummaryPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    cleanupVertexCredentials(vertexCredentials);
  }
}
