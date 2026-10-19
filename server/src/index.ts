import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const app = createApp({ env });

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[server] ReviewX (${env.appSlug}) listening on :${info.port} → ${env.publicUrl}`);
});
