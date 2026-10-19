export interface Env {
  appId: string;
  appPrivateKey: string;
  webhookSecret: string;
  appSlug: string;
  botLogin: string;
  publicUrl: string;
  port: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

export function loadEnv(): Env {
  const appSlug = process.env.APP_SLUG?.trim() || "reviewx";
  return {
    appId: required("APP_ID"),
    appPrivateKey: required("APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    webhookSecret: required("WEBHOOK_SECRET"),
    appSlug,
    botLogin: process.env.BOT_LOGIN?.trim() || `${appSlug}[bot]`,
    publicUrl: (process.env.PUBLIC_URL?.trim() || "https://reviewx.programistich.com").replace(
      /\/+$/,
      ""
    ),
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
  };
}
