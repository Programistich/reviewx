import * as core from "@actions/core";
import type { PushPermission, ShellPermission } from "../external.ts";
import { defaultSettings, type RepoSettings } from "./runContext.ts";

const PUSH_VALUES: readonly PushPermission[] = ["disabled", "restricted", "enabled"];
const SHELL_VALUES: readonly ShellPermission[] = ["disabled", "restricted", "enabled"];

function text(name: string): string | null {
  const value = core.getInput(name).trim();
  return value === "" ? null : value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = core.getInput(name).trim().toLowerCase();
  if (value === "") return fallback;
  if (value === "enabled" || value === "true" || value === "1" || value === "yes") return true;
  if (value === "disabled" || value === "false" || value === "0" || value === "no") return false;
  throw new Error(`input \`${name}\` must be enabled or disabled (got ${JSON.stringify(value)})`);
}

function oneOf<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = core.getInput(name).trim();
  if (value === "") return fallback;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`input \`${name}\` must be one of ${values.join(", ")} (got ${JSON.stringify(value)})`);
}

/**
 * Repository settings come from the workflow's `with:` block. The recommended
 * pattern is to forward GitHub Variables (`${{ vars.REVIEWX_* }}`), so an empty
 * string means "not configured" and falls back to the default.
 */
export function resolveSettingsFromInputs(): RepoSettings {
  const modeInstructions: Record<string, string> = {};
  for (const [input, mode] of [
    ["review_instructions", "Review"],
    ["fix_instructions", "Fix"],
    ["task_instructions", "Task"],
  ] as const) {
    const value = text(input);
    if (value) modeInstructions[mode] = value;
  }

  return {
    ...defaultSettings,
    model: text("model"),
    effort: null,
    setupScript: text("setup_script"),
    postCheckoutScript: text("post_checkout_script"),
    prepushScript: text("prepush_script"),
    stopScript: text("stop_script"),
    push: oneOf("push", PUSH_VALUES, defaultSettings.push),
    shell: oneOf("shell", SHELL_VALUES, defaultSettings.shell),
    prApproveEnabled: flag("pr_approve", defaultSettings.prApproveEnabled),
    reviewDrafts: flag("review_drafts", defaultSettings.reviewDrafts),
    progressComments: flag("progress_comments", defaultSettings.progressComments),
    statusChecks: flag("status_checks", defaultSettings.statusChecks),
    baseInstructions: text("base_instructions"),
    modeInstructions,
    envAllowlist: text("env_allowlist"),
  };
}
