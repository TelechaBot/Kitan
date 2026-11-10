import type { InitData, TelegramChat, TelegramUser } from "./types";

const encoder = new TextEncoder();

export function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256(
  key: string | ArrayBuffer,
  data: string,
): Promise<ArrayBuffer> {
  const keyBytes = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

export async function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
): Promise<InitData> {
  if (!initData) {
    throw new Error("initData is missing");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    throw new Error("initData hash is missing");
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // Telegram signs initData with HMAC-SHA256(key="WebAppData", message=bot_token).
  const secretKey = await hmacSha256("WebAppData", botToken);
  const expected = toHex(await hmacSha256(secretKey, dataCheckString));
  if (!constantTimeEqual(expected, hash)) {
    throw new Error("initData hash does not match");
  }

  const authDate = Number.parseInt(params.get("auth_date") ?? "", 10);
  const now = Date.now() / 1000;
  if (
    !Number.isFinite(authDate) ||
    authDate > now + 60 ||
    now - authDate > maxAgeSeconds
  ) {
    throw new Error("initData is expired");
  }

  const user = parseJson<TelegramUser>(params.get("user"), "user");
  if (typeof user.id !== "number") {
    throw new Error("initData user is invalid");
  }

  const rawChat = params.get("chat");
  const chat = rawChat ? parseJson<TelegramChat>(rawChat, "chat") : undefined;
  if (chat && typeof chat.id !== "number") {
    throw new Error("initData chat is invalid");
  }

  return { user, chat, authDate };
}

function parseJson<T>(value: string | null, field: string): T {
  if (!value) {
    throw new Error(`initData ${field} is missing`);
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`initData ${field} is invalid`);
  }
}
