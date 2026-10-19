import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { clampPermissions } from "../src/github/app.ts";
import { GITHUB_OIDC_ISSUER, REVIEWX_OIDC_AUDIENCE, verifyGitHubOidc } from "../src/github/oidc.ts";
import { tokenRoute } from "../src/routes/token.ts";

const env: Env = {
  appId: "1",
  appPrivateKey: "unused",
  webhookSecret: "unused",
  appSlug: "reviewxdev",
  botLogin: "reviewxdev[bot]",
  publicUrl: "http://localhost:3000",
  port: 3000,
};

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let verify: (token: string) => Promise<import("jose").JWTPayload>;

async function sign(claims: Record<string, unknown>, opts?: { aud?: string; iss?: string }) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(opts?.iss ?? GITHUB_OIDC_ISSUER)
    .setAudience(opts?.aud ?? REVIEWX_OIDC_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] });
  verify = async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: REVIEWX_OIDC_AUDIENCE,
    });
    return payload;
  };
});

function app(overrides: Partial<Parameters<typeof tokenRoute>[0]> = {}) {
  return tokenRoute({
    env,
    verifyOidc: (token) => verifyGitHubOidc(token, verify),
    findInstallationId: async () => 42,
    createInstallationToken: async (_app, params) => ({
      token: `ghs_${params.repositories.join(",")}_${JSON.stringify(params.permissions ?? {})}`,
      expires_at: "2099-01-01T00:00:00Z",
      installation_id: params.installationId,
    }),
    ...overrides,
  });
}

describe("POST /api/github/installation-token", () => {
  it("rejects a request without a bearer token", async () => {
    const res = await app().request("/api/github/installation-token", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects a token for another audience", async () => {
    const token = await sign({ repository: "acme/widget" }, { aud: "pullfrog-api" });
    const res = await app().request("/api/github/installation-token", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token from another issuer", async () => {
    const token = await sign({ repository: "acme/widget" }, { iss: "https://evil.example" });
    const res = await app().request("/api/github/installation-token", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("404s with an install link when the App is not installed", async () => {
    const token = await sign({ repository: "acme/widget" });
    const res = await app({ findInstallationId: async () => null }).request(
      "/api/github/installation-token",
      { method: "POST", headers: { authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("acme/widget");
    expect(body.error).toContain("https://github.com/apps/reviewxdev/installations/new");
  });

  it("mints a token scoped to the OIDC repository with clamped permissions", async () => {
    const token = await sign({
      repository: "acme/widget",
      ref: "refs/heads/main",
      runner_environment: "github-hosted",
    });
    const res = await app().request("/api/github/installation-token", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        permissions: { contents: "write", administration: "write", pull_requests: "read" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.token).toBe('ghs_widget_{"contents":"write","pull_requests":"read"}');
    expect(body.repository).toBe("acme/widget");
    expect(body.ref).toBe("refs/heads/main");
    expect(body.runner_environment).toBe("github-hosted");
    expect(body.installation_id).toBe(42);
  });
});

describe("clampPermissions", () => {
  it("drops permissions the App does not hold and widening requests", () => {
    expect(
      clampPermissions({ contents: "write", metadata: "write", secrets: "read", issues: 5 })
    ).toEqual({ contents: "write" });
  });
});
