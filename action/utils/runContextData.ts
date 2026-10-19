import type { Octokit } from "@octokit/rest";
import * as yes from "yes";
import packageJson from "../package.json" with { type: "json" };
import { log } from "./cli.ts";
import { type OctokitWithPlugins, parseRepoContext } from "./github.ts";
import { isTransientOctokitError } from "./isTransientNetworkError.ts";
import type { RepoSettings } from "./runContext.ts";
import { resolveSettingsFromInputs } from "./settingsInputs.ts";

export interface RunContextData {
  repo: {
    owner: string;
    name: string;
    data: Awaited<ReturnType<Octokit["repos"]["get"]>>["data"];
  };
  repoSettings: RepoSettings;
}

interface ResolveRunContextDataParams {
  octokit: OctokitWithPlugins;
}

/**
 * initialize run context data: parse context, fetch repo info, read settings
 * from the action inputs.
 */
export async function resolveRunContextData(
  params: ResolveRunContextDataParams
): Promise<RunContextData> {
  const actionRef = process.env.GITHUB_ACTION_REF;
  log.info(
    `» running ReviewX v${packageJson.version}${actionRef ? ` (ref: ${actionRef})` : ""}...`
  );

  const repoContext = parseRepoContext();

  // the action octokit has no retry plugin (only a 401 re-mint), and this runs
  // BEFORE the clean-error surface in main.ts — so a transient GitHub 5xx here
  // would hard-crash the run at startup. retry the transient blip. see #999.
  const repoResponse = await yes.query({
    run: () => params.octokit.repos.get({ owner: repoContext.owner, repo: repoContext.name }),
    name: "repos.get",
    retry: (error, attempt) =>
      isTransientOctokitError(error) ? yes.delay([100, 500], attempt) : -1,
  })();

  return {
    repo: {
      owner: repoContext.owner,
      name: repoContext.name,
      data: repoResponse.data,
    },
    repoSettings: resolveSettingsFromInputs(),
  };
}
