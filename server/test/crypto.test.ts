import { describe, expect, it } from "bun:test";
import { hmacSha256, toHex, verifyInitData } from "../src/crypto";

const BOT_TOKEN = "5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8";
const OFFICIAL =
  "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2";

async function makeInitData(
  botToken: string,
  authDate = Math.floor(Date.now() / 1000),
): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify({ id: 42, first_name: "Ada" }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmacSha256("WebAppData", botToken);
  params.set("hash", toHex(await hmacSha256(secret, dataCheckString)));
  return params.toString();
}

describe("verifyInitData", () => {
  it("matches Telegram's published example", async () => {
    const data = await verifyInitData(
      OFFICIAL,
      BOT_TOKEN,
      Number.MAX_SAFE_INTEGER,
    );
    expect(data.user.id).toBe(279058397);
    expect(data.authDate).toBe(1662771648);
  });

  it("reads a generated payload", async () => {
    const initData = await makeInitData(BOT_TOKEN);
    const data = await verifyInitData(initData, BOT_TOKEN, 300);
    expect(data.user.id).toBe(42);
  });

  it("rejects a tampered payload", async () => {
    const initData = await makeInitData(BOT_TOKEN);
    await expect(
      verifyInitData(
        initData.replace(/auth_date=\d+/, "auth_date=1"),
        BOT_TOKEN,
        300,
      ),
    ).rejects.toThrow("hash");
  });

  it("rejects an expired payload", async () => {
    const initData = await makeInitData(
      BOT_TOKEN,
      Math.floor(Date.now() / 1000) - 1_000,
    );
    await expect(verifyInitData(initData, BOT_TOKEN, 300)).rejects.toThrow(
      "expired",
    );
  });
});
