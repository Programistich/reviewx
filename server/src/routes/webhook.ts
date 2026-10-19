import { verify } from "@octokit/webhooks-methods";
import type { WebhookEvent } from "@octokit/webhooks-types";
import { Hono } from "hono";
import { dispatchRun, type DispatchInput, type DispatchResult } from "../dispatch/dispatch.ts";
import { decideTrigger } from "../dispatch/triggers.ts";
import type { Env } from "../env.ts";

export type WebhookRouteDeps = {
  env: Env;
  dispatch?: (env: Env, input: DispatchInput) => Promise<DispatchResult>;
  /** awaited in tests so assertions see the dispatch; production fires and forgets. */
  onDispatched?: (result: DispatchResult) => void;
};

/**
 * `POST /api/webhook`
 *
 * Verifies the GitHub App signature, decides whether the delivery starts a
 * run, acknowledges with 202 and does the GitHub work after the response so
 * GitHub's 10s delivery timeout never sees a slow token mint.
 */
export function webhookRoute(deps: WebhookRouteDeps): Hono {
  const dispatch = deps.dispatch ?? dispatchRun;
  const router = new Hono();

  router.post("/api/webhook", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const eventName = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "unknown";
    const raw = await c.req.text();

    if (!signature || !(await verify(deps.env.webhookSecret, raw, signature))) {
      return c.json({ error: "invalid signature" }, 401);
    }

    let payload: WebhookEvent;
    try {
      payload = JSON.parse(raw) as WebhookEvent;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }

    if (eventName === "ping") return c.json({ ok: true, zen: (payload as { zen?: string }).zen });

    const decision = decideTrigger(eventName, payload, {
      appSlug: deps.env.appSlug,
      botLogin: deps.env.botLogin,
    });
    if (!decision.run) {
      console.log(`[webhook ${deliveryId}] ${eventName}: skip (${decision.reason})`);
      return c.body(null, 204);
    }

    const repository = (payload as { repository?: { name: string; owner: { login: string }; default_branch: string } })
      .repository;
    if (!repository) return c.json({ error: "event has no repository" }, 400);

    const input: DispatchInput = {
      owner: repository.owner.login,
      repo: repository.name,
      defaultBranch: repository.default_branch,
      trigger: decision.trigger,
      sender: decision.sender,
    };
    console.log(
      `[webhook ${deliveryId}] ${eventName}: dispatching ${decision.trigger.trigger} for ${input.owner}/${input.repo}#${decision.trigger.number} by ${decision.sender}`
    );

    const work = dispatch(deps.env, input)
      .then((result) => {
        const detail = result.status === "dispatched" ? result.runName : result.reason;
        console.log(`[webhook ${deliveryId}] ${result.status}: ${detail}`);
        deps.onDispatched?.(result);
        return result;
      })
      .catch((error: unknown) => {
        console.error(`[webhook ${deliveryId}] dispatch crashed:`, error);
        const result: DispatchResult = {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
        deps.onDispatched?.(result);
        return result;
      });
    if (deps.onDispatched) await work;

    return c.json({ accepted: true, trigger: decision.trigger.trigger }, 202);
  });

  return router;
}
