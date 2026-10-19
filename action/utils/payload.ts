import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as core from "@actions/core";
import { type } from "arktype";
import { type AuthorPermission, type PayloadEvent, parseEffortPosition } from "../external.ts";
import packageJson from "../package.json" with { type: "json" };
import { log } from "./cli.ts";
import { isReviewx } from "./isReviewx.ts";
import type { RepoSettings } from "./runContext.ts";
import { validateCompatibility } from "./versioning.ts";

// raises THIS run's logging. enumerated like its sibling toggles so a typo
// hard-fails at Inputs.assert rather than silently leaving debug off — the one
// failure mode you cannot afford in a switch whose purpose is seeing into a run
// you cannot see into.
const DebugInput = type.enumerated("disabled", "enabled");

// schema for JSON payload passed via prompt (internal dispatch invocation)
// note: permissions are intentionally NOT included here to prevent injection attacks
// permissions are derived from event.authorPermission instead
export const JsonPayload = type({
  "~reviewx": "true",
  version: "string",
  // the server's run type, forwarded verbatim to run-context. optional so a
  // payload from an older server build still parses against a newer action.
  "type?": "string | undefined",
  "model?": "string | undefined",
  "effort?": "number | string | undefined",
  "debug?": "boolean | undefined",
  prompt: "string",
  "triggerer?": "string | undefined",

  "baseInstructions?": "string | undefined",
  "eventInstructions?": "string",
  "previousRunsNote?": "string",
  "event?": "object",
  "timeout?": "string | undefined",
  "progressComment?": type({
    id: "string",
    type: "'issue' | 'review'",
  }).or("undefined"),
  // optional so a payload from an older server build (pre-`checkRun`) still parses
  // against a newer action across a rolling deploy.
  "checkRun?": type({ id: "string" }).or("undefined"),
});

// permission levels that indicate collaborator status (have push access)
const COLLABORATOR_PERMISSIONS: AuthorPermission[] = ["admin", "maintain", "write"];

// check if the event author has collaborator-level permissions
function isCollaborator(event: PayloadEvent): boolean {
  const perm = event.authorPermission;
  return perm !== undefined && COLLABORATOR_PERMISSIONS.includes(perm);
}

// inputs schema - action inputs from core.getInput()
// note: tool permissions use .or("undefined") because getInput() || undefined
// explicitly sets the property to undefined when empty, which is different from
// the property being absent. arktype's "prop?" means "optional to include" but
// if included, must match the type - so we need to explicitly allow undefined.
export const Inputs = type({
  "prompt?": type.string.or("undefined"),
  "prompt_file?": type.string.or("undefined"),
  "model?": type.string.or("undefined"),
  "effort?": type.string.or("undefined"),
  "debug?": DebugInput.or("undefined"),
  "timeout?": type.string.or("undefined"),
  // read by `resolveSettingsFromInputs`; listed here so fixtures can type them.
  "push?": type.enumerated("disabled", "restricted", "enabled").or("undefined"),
  "shell?": type.enumerated("disabled", "restricted", "enabled").or("undefined"),
  "cwd?": type.string.or("undefined"),
  "output_schema?": type.string.or("undefined"),
});

export type Inputs = typeof Inputs.infer;

function isPayloadEvent(value: unknown): value is PayloadEvent {
  return typeof value === "object" && value !== null && "trigger" in value;
}

function resolveCwd(cwd: string | undefined): string | undefined {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!cwd) return workspace;
  if (isAbsolute(cwd)) return cwd;
  return workspace ? resolve(workspace, cwd) : cwd;
}

export type ResolvedPromptInput = string | typeof JsonPayload.infer;

/**
 * the envelope's marker key, searched for in the RAW input rather than a parse result —
 * the whole point is a payload that no longer parses. a plain substring rather than a
 * regex, so it doubles as the cheap pre-filter and as an honest scan bound.
 */
const DISPATCH_PAYLOAD_KEY = '"~reviewx"';

/**
 * the complete JSON object starting at `open`, or undefined when its braces never balance.
 * string-aware: a brace inside a JSON string value is punctuation, not structure, and the
 * envelope's `prompt` and `baseInstructions` routinely contain both braces and quotes.
 */
function sliceBalancedObject(text: string, open: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
}

/**
 * a COMPLETE, schema-valid dispatch envelope embedded anywhere in `text`, or undefined.
 *
 * exact rather than heuristic, and that distinction is the whole point: `prompt` is a public
 * arbitrary-string input, so any predicate looser than "this parses as a real envelope"
 * refuses prompts that merely QUOTE one — and the people most likely to write such a prompt
 * are whoever is working on this file. `{"~reviewx": true, "version": "1.2.3"}` fails
 * `JsonPayload` (no `prompt`) and passes through; a genuinely mangled dispatch does not.
 *
 * EVERY `{` before the LAST marker is tried, because a preamble may quote an abbreviated
 * marker of its own before interpolating the real envelope — anchoring on the first
 * occurrence would leave that envelope invisible and preserve the exact silent downgrade
 * this guard exists to stop. an object opens before its own key, so the last marker is a
 * sound upper bound, and the whole scan sits behind a substring miss that costs one pass.
 *
 * `version` is deliberately NOT compatibility-checked: a version we would refuse to RUN is
 * still unambiguously our envelope, and saying so beats a confusing silent downgrade.
 */
function findEmbeddedDispatchPayload(text: string): unknown {
  const limit = text.lastIndexOf(DISPATCH_PAYLOAD_KEY);
  if (limit === -1) return undefined;
  for (
    let open = text.indexOf("{");
    open !== -1 && open < limit;
    open = text.indexOf("{", open + 1)
  ) {
    const candidate = sliceBalancedObject(text, open);
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (JsonPayload.allows(parsed)) return parsed;
    } catch {
      // this `{` did not open an envelope; try the next
    }
  }
  return undefined;
}

/**
 * a workflow whose `prompt:` interpolates `${{ inputs.prompt }}` into a larger block hands
 * us a dispatch payload we cannot parse, and every field on it is then lost in SILENCE:
 * the seeded progress comment (so the "Leaping into action..." comment strands on the PR
 * until the completion webhook sweeps it and alerts), the event (so the run has no PR
 * number, and `expectsReviewOutput` retires the unsubmitted-review gate — a Review run
 * that submits nothing then exits `success`), the check run, standing instructions, and
 * the cross-repo grant. the run bills a full agent turn and delivers a fraction of the
 * ask, with nothing anywhere saying why. refuse instead: `core.setFailed` renders this as
 * an annotation on the run, and the fix is one line of YAML.
 */
function assertDispatchPayloadIntact(promptInput: string): void {
  if (!findEmbeddedDispatchPayload(promptInput)) return;
  throw new Error(
    "this workflow wraps `${{ inputs.prompt }}` in other text, so ReviewX's dispatch payload " +
      "can't be read and the run would lose its pull request context, its progress comment, and " +
      "its standing instructions. in `.github/workflows/reviewx.yml`, set `prompt:` to exactly " +
      "`${{ inputs.prompt }}`, and move your own preamble into Standing instructions in the " +
      "ReviewX console."
  );
}

export function resolvePromptInput(): ResolvedPromptInput {
  const promptInput = core.getInput("prompt");
  const promptFile = core.getInput("prompt_file");

  if (promptInput && promptFile) {
    throw new Error("set exactly one of 'prompt' or 'prompt_file' inputs, not both.");
  }

  // a prompt file holds a human-authored prompt, so it is returned verbatim and
  // never parsed as an internal reviewx JSON dispatch payload.
  if (promptFile) {
    return resolvePromptFile(promptFile);
  }

  if (!promptInput) {
    throw new Error("one of 'prompt' or 'prompt_file' inputs is required.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(promptInput);
  } catch {
    // JSON parse error is fine (plain text prompt)
  }

  if (!parsed || typeof parsed !== "object" || !("~reviewx" in parsed)) {
    // both ways of getting here — unparseable, or parsed but not ours — are also how a
    // MANGLED dispatch payload arrives, which is fatal rather than plain text.
    assertDispatchPayloadIntact(promptInput);
    // if it doesn't look like a reviewx payload, return the plain text prompt
    return promptInput;
  }

  // validation errors should propagate
  const jsonPayload = JsonPayload.assert(parsed);
  validateCompatibility(jsonPayload.version, packageJson.version);
  return jsonPayload;
}

// the path is workflow-author-controlled (anyone who can set prompt_file can
// already run arbitrary job steps), so we resolve, read, and empty-check it
// without sandbox-grade path validation.
function resolvePromptFile(input: string): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  const path = isAbsolute(input) ? input : workspace ? resolve(workspace, input) : resolve(input);
  const content = readFileSync(path, "utf-8");
  if (!content.trim()) {
    throw new Error(`prompt_file ${JSON.stringify(input)} is empty.`);
  }
  return content;
}

function resolveNonPromptInputs() {
  return Inputs.omit("prompt", "prompt_file").assert({
    model: core.getInput("model") || undefined,
    effort: core.getInput("effort") || undefined,
    debug: core.getInput("debug") || undefined,
    timeout: core.getInput("timeout") || undefined,
    cwd: core.getInput("cwd") || undefined,
  });
}

export function resolvePayload(
  resolvedPromptInput: ResolvedPromptInput,
  repoSettings: RepoSettings
) {
  const [prompt, jsonPayload] =
    typeof resolvedPromptInput !== "string"
      ? [resolvedPromptInput.prompt, resolvedPromptInput]
      : [resolvedPromptInput, undefined];

  const inputs = resolveNonPromptInputs();

  // resolve event - use type guard for jsonPayload.event, fallback to unknown trigger
  const rawEvent = jsonPayload?.event;
  const event: PayloadEvent = isPayloadEvent(rawEvent) ? rawEvent : { trigger: "unknown" };

  const model = jsonPayload?.model ?? inputs.model ?? repoSettings.model ?? undefined;

  // same precedence as model. carried as a POSITION on [0,1] rather than a rung
  // name, so it stays meaningful if the model changes underneath it. an
  // unparseable value is dropped rather than guessed — unset means the harness
  // applies the model's own default.
  const rawEffort = jsonPayload?.effort ?? inputs.effort ?? repoSettings.effort ?? undefined;
  const effort = rawEffort === undefined ? undefined : parseEffortPosition(String(rawEffort));

  // `--debug` (or the `debug` input) raises this run's logging. routed through
  // LOG_LEVEL rather than a threaded boolean so the one existing switch —
  // `isDebugEnabled` in utils/activity.ts — turns up every diagnostic we own:
  // `log.debug` output and opencode's own server log level.
  const debug = jsonPayload?.debug ?? inputs.debug === "enabled";
  if (debug) process.env.LOG_LEVEL = "debug";

  // determine shell permission: the `shell` input (via repoSettings) decides,
  // but non-collaborators always get at most "restricted".
  const isNonCollaborator = !isCollaborator(event);
  let resolvedShell = repoSettings.shell;
  if (isNonCollaborator && resolvedShell === "enabled") {
    resolvedShell = "restricted";
  }

  // build payload - precedence: inputs > repoSettings > fallbacks
  // note: modes are NOT in payload - they come from repoSettings in main()
  return {
    "~reviewx": true as const,
    version: jsonPayload?.version ?? packageJson.version,
    model,
    effort,
    debug: debug || undefined,
    prompt,
    triggerer:
      jsonPayload?.triggerer ??
      // it's not a common use case but GITHUB_ACTOR can be a user when the workflow is manually triggered by a user through GitHub Actions UI
      (!isReviewx(process.env.GITHUB_ACTOR) ? process.env.GITHUB_ACTOR : undefined),
    baseInstructions: jsonPayload?.baseInstructions ?? repoSettings.baseInstructions ?? undefined,
    eventInstructions: jsonPayload?.eventInstructions,
    previousRunsNote: jsonPayload?.previousRunsNote,
    event,
    timeout: inputs.timeout ?? jsonPayload?.timeout,
    cwd: resolveCwd(inputs.cwd),
    progressComment: jsonPayload?.progressComment,
    checkRun: jsonPayload?.checkRun,

    push: repoSettings.push,
    shell: resolvedShell,

    // the `reviewx` run-lifecycle check. ON by default — the whole point is that a PR
    // shows whether ReviewX is running without anyone having to opt in.
    runStatusCheck: repoSettings.statusChecks,

    // the `reviewx-approval` verdict check. off by default — it is a merge gate.
    approvalCheck: repoSettings.approvalCheck,

    // live task-list updates in the progress comment. defaults to true.
    progressComments: repoSettings.progressComments,
  };
}

export type ResolvedPayload = ReturnType<typeof resolvePayload>;

/**
 * Parse and validate the optional `output_schema` action input. Returns the
 * parsed object when present, or `undefined` when absent. Throws on invalid
 * JSON or non-object payloads — these are workflow-author errors that should
 * surface immediately, not silently degrade to "no schema".
 */
export function resolveOutputSchema(): Record<string, unknown> | undefined {
  const raw = core.getInput("output_schema");
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid output_schema: not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid output_schema: must be a JSON object`);
  }
  log.info("» structured output schema provided — output will be required");
  return parsed as Record<string, unknown>;
}
