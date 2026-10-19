import { createSign } from "node:crypto";

type ReadWrite = "read" | "write";

/**
 * Installation access token permissions, passed verbatim to
 * `POST /app/installations/{id}/access_tokens`. Only the subset the App itself
 * was granted can be requested; GitHub 422s on anything wider.
 */
export type AppPermissions = {
  actions?: ReadWrite;
  checks?: ReadWrite;
  contents?: ReadWrite;
  issues?: ReadWrite;
  metadata?: "read";
  pull_requests?: ReadWrite;
  statuses?: ReadWrite;
  workflows?: "write";
};

/** every permission the ReviewX App requests at registration. */
export const APP_PERMISSIONS: Readonly<Required<AppPermissions>> = {
  actions: "write",
  checks: "write",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
  statuses: "write",
  workflows: "write",
};

export interface InstallationToken {
  token: string;
  expires_at: string;
  installation_id: number;
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

const base64Url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

/** RS256 App JWT, valid for 5 minutes, `iat` backdated 60s for clock skew. */
export function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 5 * 60, iss: appId }));
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `${header}.${payload}.${signature}`;
}

async function githubRequest<T>(
  path: string,
  init: { method?: string; token: string; body?: unknown }
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "reviewx-server",
      Authorization: `Bearer ${init.token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GitHubApiError(
      response.status,
      `GitHub API ${init.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`
    );
  }
  return (await response.json()) as T;
}

export interface GitHubApp {
  appId: string;
  privateKey: string;
}

/** installation id for a repository, or null when the App is not installed there. */
export async function findInstallationId(
  app: GitHubApp,
  owner: string,
  repo: string
): Promise<number | null> {
  try {
    const installation = await githubRequest<{ id: number }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      { token: createAppJwt(app.appId, app.privateKey) }
    );
    return installation.id;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

/** narrow `requested` to what the App actually holds; unknown keys are dropped. */
export function clampPermissions(requested: Record<string, unknown> | undefined): AppPermissions {
  const clamped: Record<string, string> = {};
  if (!requested) return {};
  for (const [key, value] of Object.entries(requested)) {
    const granted = (APP_PERMISSIONS as Record<string, string>)[key];
    if (!granted || typeof value !== "string") continue;
    if (value === "read" || value === granted) clamped[key] = value;
  }
  return clamped as AppPermissions;
}

export async function createInstallationToken(
  app: GitHubApp,
  params: { installationId: number; repositories: string[]; permissions?: AppPermissions }
): Promise<InstallationToken> {
  const body: Record<string, unknown> = { repositories: params.repositories };
  if (params.permissions && Object.keys(params.permissions).length > 0) {
    body.permissions = params.permissions;
  }
  const result = await githubRequest<{ token: string; expires_at: string }>(
    `/app/installations/${params.installationId}/access_tokens`,
    { method: "POST", token: createAppJwt(app.appId, app.privateKey), body }
  );
  return { token: result.token, expires_at: result.expires_at, installation_id: params.installationId };
}

export async function revokeInstallationToken(token: string): Promise<void> {
  await fetch("https://api.github.com/installation/token", {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "reviewx-server",
      Authorization: `Bearer ${token}`,
    },
  }).catch(() => undefined);
}
