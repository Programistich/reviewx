import { modelAliases, modelIdLabel, resolveDisplayAlias } from "../models.ts";

export const REVIEWX_DIVIDER = "<!-- REVIEWX_DIVIDER_DO_NOT_REMOVE -->";

export const REVIEWX_REPO_URL = "https://github.com/programistich/reviewx";

export interface WorkflowRunFooterInfo {
  owner: string;
  repo: string;
  runId: number;
  /** optional job ID - if provided, will append /job/{jobId} to the workflow run URL */
  jobId?: string | undefined;
}

export interface BuildFooterParams {
  /** add "View workflow run" link */
  workflowRun?: WorkflowRunFooterInfo | undefined;
  /** alternative: just pass a pre-built URL directly */
  workflowRunUrl?: string | undefined;
  /** arbitrary custom parts (e.g., action hints) */
  customParts?: string[] | undefined;
  /** model slug from payload (e.g., "anthropic/claude-opus"). shown in footer as "Using `claude-opus-5-5`" */
  model?: string | undefined;
}

function formatModelLabel(model: string): string {
  const slugAlias = resolveDisplayAlias(model);
  const alias =
    slugAlias ?? modelAliases.find((a) => a.resolve === model || a.openRouterResolve === model);
  const modelName = slugAlias?.routing
    ? slugAlias.displayName
    : modelIdLabel(slugAlias?.resolve ?? model);
  return alias?.isFree ? `\`${modelName}\` (free)` : `\`${modelName}\``;
}

/**
 * build the ReviewX footer with configurable parts
 * order: custom parts > workflow run > model > attribution
 */
export function buildFooter(params: BuildFooterParams): string {
  const parts: string[] = [];

  if (params.customParts) {
    parts.push(...params.customParts);
  }

  if (params.workflowRunUrl) {
    parts.push(`[View workflow run](${params.workflowRunUrl})`);
  } else if (params.workflowRun) {
    const baseUrl = `https://github.com/${params.workflowRun.owner}/${params.workflowRun.repo}/actions/runs/${params.workflowRun.runId}`;
    const url = params.workflowRun.jobId ? `${baseUrl}/job/${params.workflowRun.jobId}` : baseUrl;
    parts.push(`[View workflow run](${url})`);
  }

  if (params.model) {
    parts.push(`Using ${formatModelLabel(params.model)}`);
  }

  parts.push(`[ReviewX](${REVIEWX_REPO_URL})`);

  return `\n\n${REVIEWX_DIVIDER}\n<sup>${parts.join(" ｜ ")}</sup>`;
}

/**
 * strip any existing ReviewX footer from a comment body
 */
export function stripExistingFooter(body: string): string {
  const dividerIndex = body.indexOf(REVIEWX_DIVIDER);
  if (dividerIndex === -1) {
    return body;
  }
  return body.substring(0, dividerIndex).trimEnd();
}
