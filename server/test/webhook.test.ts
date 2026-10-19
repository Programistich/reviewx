import { sign } from "@octokit/webhooks-methods";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { createApp } from "../src/app.ts";
import type { DispatchInput, DispatchResult } from "../src/dispatch/dispatch.ts";

const env: Env = {
  appId: "1",
  appPrivateKey: "unused",
  webhookSecret: "s3cret",
  appSlug: "reviewx",
  botLogin: "reviewx[bot]",
  publicUrl: "http://localhost:3000",
  port: 3000,
};

const prOpened = {
  action: "opened",
  number: 7,
  pull_request: {
    number: 7,
    state: "open",
    draft: false,
    title: "t",
    body: null,
    user: { login: "alice" },
    head: { ref: "f", sha: "b".repeat(40) },
  },
  repository: { name: "widget", owner: { login: "acme" }, default_branch: "main" },
  sender: { login: "alice" },
};

async function post(
  body: unknown,
  opts: { event: string; secret?: string; dispatch?: (env: Env, input: DispatchInput) => Promise<DispatchResult> }
) {
  const raw = JSON.stringify(body);
  const dispatched: DispatchInput[] = [];
  const app = createApp({
    env,
    webhook: {
      dispatch: async (e, input) => {
        dispatched.push(input);
        return opts.dispatch ? opts.dispatch(e, input) : { status: "dispatched", runName: "x" };
      },
      onDispatched: () => undefined,
    },
  });
  const res = await app.request("/api/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": opts.event,
      "x-github-delivery": "d1",
      "x-hub-signature-256": await sign(opts.secret ?? env.webhookSecret, raw),
    },
    body: raw,
  });
  return { res, dispatched };
}

describe("POST /api/webhook", () => {
  it("rejects a bad signature", async () => {
    const { res, dispatched } = await post(prOpened, { event: "pull_request", secret: "wrong" });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it("answers ping", async () => {
    const { res } = await post({ zen: "Keep it logically awesome." }, { event: "ping" });
    expect(res.status).toBe(200);
  });

  it("204s on events that do not start a run", async () => {
    const { res, dispatched } = await post({ ...prOpened, action: "closed" }, { event: "pull_request" });
    expect(res.status).toBe(204);
    expect(dispatched).toHaveLength(0);
  });

  it("202s and dispatches an opened PR with repository context", async () => {
    const { res, dispatched } = await post(prOpened, { event: "pull_request" });
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([
      {
        owner: "acme",
        repo: "widget",
        defaultBranch: "main",
        sender: "alice",
        trigger: expect.objectContaining({ trigger: "pull_request_opened", number: 7 }),
      },
    ]);
  });

  it("serves healthz", async () => {
    const app = createApp({ env });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, app: "reviewx" });
  });
});
