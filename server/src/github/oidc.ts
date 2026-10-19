import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const REVIEWX_OIDC_AUDIENCE = "reviewx-api";

export interface OidcClaims {
  /** `owner/repo` the workflow run belongs to */
  repository: string;
  owner: string;
  repo: string;
  ref: string;
  runId: string;
  runnerEnvironment: string;
  raw: JWTPayload;
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

type Verifier = (token: string) => Promise<JWTPayload>;

function githubVerifier(): Verifier {
  const jwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: REVIEWX_OIDC_AUDIENCE,
    });
    return payload;
  };
}

let defaultVerifier: Verifier | undefined;

/**
 * Verify a GitHub Actions OIDC token and extract the claims the token
 * endpoint needs. `verify` is injectable for tests; production uses GitHub's
 * JWKS with jose's built-in caching.
 */
export async function verifyGitHubOidc(
  token: string,
  verify: Verifier = (defaultVerifier ??= githubVerifier())
): Promise<OidcClaims> {
  let payload: JWTPayload;
  try {
    payload = await verify(token);
  } catch (error) {
    throw new OidcError(`invalid OIDC token: ${error instanceof Error ? error.message : error}`);
  }
  const repository = payload.repository;
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw new OidcError("OIDC token has no repository claim");
  }
  const [owner, repo] = repository.split("/", 2) as [string, string];
  return {
    repository,
    owner,
    repo,
    ref: typeof payload.ref === "string" ? payload.ref : "",
    runId: typeof payload.run_id === "string" ? payload.run_id : "",
    runnerEnvironment:
      typeof payload.runner_environment === "string" ? payload.runner_environment : "",
    raw: payload,
  };
}
