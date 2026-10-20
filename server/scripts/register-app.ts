/**
 * One-shot GitHub App registration via the manifest flow.
 *
 *   node --experimental-strip-types scripts/register-app.ts <public-url> [--name <app-name>] [--public]
 *
 * Serves a page at <public-url>/setup that posts the manifest to GitHub. After
 * you confirm there, GitHub redirects to /setup/callback?code=…; the script
 * exchanges the code for the App's id, private key and webhook secret, writes
 * them to $REVIEWX_LOCAL_DIR/<slug>.env (default: ./.local) and exits.
 */
import { serve } from "@hono/node-server";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

const args = process.argv.slice(2);
const publicUrl = args.find((a) => a.startsWith("http"))?.replace(/\/+$/, "");
if (!publicUrl) {
  console.error("usage: register-app.ts <public-url> [--name <app-name>] [--public]");
  process.exit(1);
}
const nameIdx = args.indexOf("--name");
const name = nameIdx === -1 ? "reviewx-dev" : (args[nameIdx + 1] ?? "reviewx-dev");
const isPublic = args.includes("--public");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const manifest = {
  name,
  url: "https://github.com/programistich/reviewx",
  description: "AI code review for pull requests, running in your own GitHub Actions with your own model keys.",
  hook_attributes: { url: `${publicUrl}/api/webhook`, active: true },
  redirect_url: `${publicUrl}/setup/callback`,
  public: isPublic,
  default_permissions: {
    actions: "write",
    checks: "write",
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
    statuses: "write",
    workflows: "write",
  },
  default_events: ["pull_request", "issue_comment", "pull_request_review_comment"],
};

const app = new Hono();

app.get("/setup", (c) =>
  c.html(`<!doctype html><meta charset="utf-8"><title>Register ${name}</title>
<body style="font:16px system-ui;max-width:40em;margin:4em auto">
<h1>Register GitHub App <code>${name}</code></h1>
<p>Webhook: <code>${manifest.hook_attributes.url}</code><br>Installable by: ${isPublic ? "any account" : "only you"}</p>
<form method="post" action="https://github.com/settings/apps/new">
<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
<button style="font-size:1.2em;padding:.5em 1.5em">Create on GitHub →</button>
</form></body>`)
);

app.get("/setup/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("missing ?code", 400);
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "reviewx-register" },
  });
  if (!res.ok) return c.text(`conversion failed: ${res.status} ${await res.text()}`, 502);
  const data = (await res.json()) as {
    id: number;
    slug: string;
    pem: string;
    webhook_secret: string;
    html_url: string;
  };
  const dir = process.env.REVIEWX_LOCAL_DIR ?? join(process.cwd(), ".local");
  mkdirSync(dir, { recursive: true });
  const envPath = join(dir, `${data.slug}.env`);
  const envBody =
    [
      `APP_ID=${data.id}`,
      `APP_PRIVATE_KEY="${data.pem.replace(/\n/g, "\\n")}"`,
      `WEBHOOK_SECRET=${data.webhook_secret}`,
      `APP_SLUG=${data.slug}`,
      `BOT_LOGIN=${data.slug}[bot]`,
      `PUBLIC_URL=${publicUrl}`,
      `PORT=${port}`,
      "",
    ].join("\n");
  try {
    writeFileSync(envPath, envBody, { mode: 0o600 });
  } catch (error) {
    // the manifest code is single-use: losing the credentials here means re-registering.
    console.error(`» could not write ${envPath}: ${error}. credentials follow on stdout:`);
    console.log(envBody);
    return c.text(`registered ${data.slug} but could not write ${envPath}; see container logs`, 500);
  }
  console.log(`» registered ${data.slug} (id ${data.id}) → ${envPath}`);
  console.log(`» install it: ${data.html_url}/installations/new`);
  setTimeout(() => process.exit(0), 500);
  return c.html(
    `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:40em;margin:4em auto">
<h1>Done</h1><p>Credentials written to <code>${envPath}</code>.</p>
<p><a href="${data.html_url}/installations/new">Install ${data.slug} on a repository →</a></p></body>`
  );
});

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`» open ${publicUrl}/setup to register ${name}`);
});
