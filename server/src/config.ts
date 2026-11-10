export interface Config {
  botToken: string;
  adminUserId?: string;
  databasePath: string;
  apiBase: string;
  publicAppUrl: string;
  turnstileSiteKey: string;
  turnstileSecretKey: string;
  allowInsecure: boolean;
  port: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadConfig(): Config {
  const publicAppUrl = required("PUBLIC_APP_URL");
  const allowInsecure = process.env.ALLOW_INSECURE === "true";
  const siteKey = process.env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const secretKey = process.env.TURNSTILE_SECRET_KEY?.trim() ?? "";

  if (Boolean(siteKey) !== Boolean(secretKey)) {
    throw new Error(
      "Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither",
    );
  }
  if (!allowInsecure && !secretKey) {
    throw new Error(
      "TURNSTILE_SECRET_KEY is required unless ALLOW_INSECURE=true",
    );
  }

  const url = new URL(publicAppUrl);
  if (url.protocol !== "https:" && !allowInsecure) {
    throw new Error("PUBLIC_APP_URL must use https");
  }

  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  if (!Number.isFinite(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid port number");
  }

  return {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    adminUserId: process.env.TELEGRAM_ADMIN_USER_ID?.trim() || undefined,
    databasePath: process.env.DATABASE_PATH?.trim() || "./data/kitan.db",
    apiBase: (
      process.env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org"
    ).replace(/\/$/, ""),
    publicAppUrl: url.toString().replace(/\/$/, ""),
    turnstileSiteKey: siteKey,
    turnstileSecretKey: secretKey,
    allowInsecure,
    port,
  };
}
