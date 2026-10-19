import { Hono } from "hono";
import type { Env } from "../env.ts";
import {
  clampPermissions,
  createInstallationToken,
  findInstallationId,
  GitHubApiError,
} from "../github/app.ts";
import { OidcError, verifyGitHubOidc } from "../github/oidc.ts";

export type TokenRouteDeps = {
  env: Env;
  verifyOidc?: typeof verifyGitHubOidc;
  findInstallationId?: typeof findInstallationId;
  createInstallationToken?: typeof createInstallationToken;
};

/**
 * `POST /api/github/installation-token`
 *
 * The action presents its GitHub Actions OIDC token (audience `reviewx-api`)
 * and gets back an installation token for the repository the run belongs to,
 * scoped to the permissions it asked for (clamped to what the App holds).
 * Stateless: the OIDC token's `repository` claim is the only authority.
 */
export function tokenRoute(deps: TokenRouteDeps): Hono {
  const verify = deps.verifyOidc ?? verifyGitHubOidc;
  const findInstallation = deps.findInstallationId ?? findInstallationId;
  const mint = deps.createInstallationToken ?? createInstallationToken;
  const app = { appId: deps.env.appId, privateKey: deps.env.appPrivateKey };
  const installUrl = `https://github.com/apps/${deps.env.appSlug}/installations/new`;

  const router = new Hono();

  router.post("/api/github/installation-token", async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!match) return c.json({ error: "missing bearer token" }, 401);

    let claims;
    try {
      claims = await verify(match[1]!);
    } catch (error) {
      const message = error instanceof OidcError ? error.message : "invalid OIDC token";
      return c.json({ error: message }, 401);
    }

    let requested: Record<string, unknown> | undefined;
    const body = await c.req.text();
    if (body.trim()) {
      try {
        const parsed = JSON.parse(body) as { permissions?: Record<string, unknown> };
        requested = parsed?.permissions;
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
    }

    const installationId = await findInstallation(app, claims.owner, claims.repo);
    if (installationId === null) {
      return c.json(
        {
          error: `ReviewX is not installed on ${claims.repository}. Install it: ${installUrl}`,
        },
        404
      );
    }

    try {
      const token = await mint(app, {
        installationId,
        repositories: [claims.repo],
        permissions: clampPermissions(requested),
      });
      return c.json({
        token: token.token,
        expires_at: token.expires_at,
        installation_id: token.installation_id,
        repository: claims.repository,
        ref: claims.ref,
        runner_environment: claims.runnerEnvironment,
      });
    } catch (error) {
      if (error instanceof GitHubApiError) {
        console.error(`[token] GitHub refused the mint for ${claims.repository}: ${error.message}`);
        return c.json({ error: `GitHub refused to issue a token: ${error.status}` }, 502);
      }
      throw error;
    }
  });

  return router;
}
