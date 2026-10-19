import { Hono } from "hono";
import type { Env } from "./env.ts";
import { tokenRoute, type TokenRouteDeps } from "./routes/token.ts";
import { webhookRoute, type WebhookRouteDeps } from "./routes/webhook.ts";

export type AppDeps = {
  env: Env;
  token?: Omit<TokenRouteDeps, "env">;
  webhook?: Omit<WebhookRouteDeps, "env">;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, app: deps.env.appSlug }));
  app.get("/", (c) => c.redirect("https://github.com/programistich/reviewx", 302));
  app.route("/", tokenRoute({ env: deps.env, ...deps.token }));
  app.route("/", webhookRoute({ env: deps.env, ...deps.webhook }));
  app.onError((error, c) => {
    console.error(`[server] ${c.req.method} ${c.req.path} failed:`, error);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
