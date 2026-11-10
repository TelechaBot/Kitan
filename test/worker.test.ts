import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { hmacSha256, toHex } from "../src/crypto";
import { MESSAGES } from "../src/i18n";
import worker, { expirePending } from "../src/index";
import type { Env } from "../src/types";

const TOKEN = "123:test-bot-token";
const SECRET = "hook-secret";
const ORIGIN = "https://kitan.example.workers.dev";

// Minimal D1 over bun:sqlite: enough of prepare/bind/first/all/run for the worker.
function d1(db: Database) {
  const statement = (sql: string, args: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.query(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: db.query(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: db.query(sql).run(...(args as never[])).changes } }),
  });
  return { prepare: (sql: string) => statement(sql, []) };
}

let db: Database;
let env: Env;
let calls: { method: string; params: Record<string, any> }[];
let turnstile: { success: boolean; hostname?: string };
let failMethods: Record<string, string>;

beforeEach(() => {
  db = new Database(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) {
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  env = {
    DB: d1(db) as unknown as D1Database,
    TELEGRAM_BOT_TOKEN: TOKEN,
    WEBHOOK_SECRET: SECRET,
    TURNSTILE_SITE_KEY: "site",
    TURNSTILE_SECRET_KEY: "secret",
  };
  calls = [];
  turnstile = { success: true, hostname: "kitan.example.workers.dev" };
  failMethods = {};
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("turnstile")) {
      return Response.json(turnstile);
    }
    const method = url.split("/").pop()!;
    const params = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, params });
    if (failMethods[method]) {
      return Response.json({ ok: false, description: failMethods[method] });
    }
    return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: 77 } : true });
  }) as typeof fetch;
});

async function initData(fields: Record<string, string>): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 42, first_name: "A" }),
    ...fields,
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  params.set("hash", toHex(await hmacSha256(await hmacSha256("WebAppData", TOKEN), check)));
  return params.toString();
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

const hook = (update: unknown) =>
  post("/telegram", update, { "x-telegram-bot-api-secret-token": SECRET });

const joinRequest = (extra: Record<string, unknown> = {}) => ({
  update_id: 1,
  chat_join_request: {
    chat: { id: -100, title: "G" },
    from: { id: 42 },
    user_chat_id: 42,
    date: 0,
    ...extra,
  },
});

const row = () => db.query("SELECT * FROM attempts").get() as Record<string, any>;

test("webhook rejects a wrong secret", async () => {
  const response = await post("/telegram", joinRequest(), { "x-telegram-bot-api-secret-token": "x" });
  expect(response.status).toBe(401);
  expect(calls).toHaveLength(0);
});

test("guard path: Mini App, open, verify, approve", async () => {
  await hook(joinRequest({ query_id: "Q1" }));
  expect(calls[0]).toEqual({
    method: "sendChatJoinRequestWebApp",
    params: { chat_join_request_query_id: "Q1", web_app_url: `${ORIGIN}/` },
  });

  const data = await initData({ chat_join_request_query_id: "Q1" });
  const opened = await post("/api/open", { initData: data });
  expect(opened.status).toBe(200);
  expect((await opened.json()).chat_title).toBe("G");
  const response = await post("/api/verify", { initData: data, turnstileToken: "t", solveMs: 1800 });
  expect(response.status).toBe(200);
  expect(calls.at(-1)).toEqual({
    method: "answerChatJoinRequestQuery",
    params: { chat_join_request_query_id: "Q1", result: "approve" },
  });
  const attempt = row();
  expect(attempt.status).toBe("approved");
  expect(attempt.tries).toBe(1);
  expect(attempt.solve_ms).toBe(1800);
  expect(attempt.opened_at).toBeGreaterThan(0);

  // A second submission cannot approve again.
  expect((await post("/api/verify", { initData: data, turnstileToken: "t" })).status).toBe(409);
});

test("guard path: duplicate delivery is ignored", async () => {
  await hook(joinRequest({ query_id: "Q1" }));
  await hook(joinRequest({ query_id: "Q1" }));
  expect(calls.filter((c) => c.method === "sendChatJoinRequestWebApp")).toHaveLength(1);
});

test("guard path: failed Mini App launch queues the request for admins", async () => {
  failMethods.sendChatJoinRequestWebApp = "Bad Request";
  await hook(joinRequest({ query_id: "Q1" }));
  expect(calls.at(-1)?.params.result).toBe("queue");
  expect(row().status).toBe("failed");
  expect(row().error).toBe("sendChatJoinRequestWebApp: Bad Request");
});

test("dm path: message, verify with token, approve, delete message", async () => {
  await hook(joinRequest());
  expect(calls[0].method).toBe("sendMessage");
  const token = row().token;
  expect(calls[0].params.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`${ORIGIN}/?token=${token}`);

  const data = await initData({});
  const response = await post("/api/verify", { initData: data, token, turnstileToken: "t" });
  expect(response.status).toBe(200);
  expect(calls.map((c) => c.method)).toEqual(["sendMessage", "approveChatJoinRequest", "deleteMessage"]);
});

test("every language has every message", () => {
  const keys = Object.keys(MESSAGES.en).sort();
  for (const [lang, messages] of Object.entries(MESSAGES)) {
    expect([lang, Object.keys(messages).sort()]).toEqual([lang, keys]);
  }
});

test("dm path speaks the requester's language", async () => {
  await hook(joinRequest({ from: { id: 42, language_code: "zh-hans" } }));
  expect(calls[0].params.text).toBe("要加入「⁨G⁩」，请在 5 分钟内完成人机验证。");
  expect(calls[0].params.reply_markup.inline_keyboard[0][0].text).toBe("开始验证");
});

test("verify rejects another user's token", async () => {
  await hook(joinRequest());
  const token = row().token;
  const data = await initData({ user: JSON.stringify({ id: 7 }) });
  expect((await post("/api/verify", { initData: data, token, turnstileToken: "t" })).status).toBe(404);
});

test("verify rejects forged initData", async () => {
  await hook(joinRequest({ query_id: "Q1" }));
  const data = (await initData({ chat_join_request_query_id: "Q1" })).replace(/hash=\w+/, "hash=00");
  expect((await post("/api/verify", { initData: data, turnstileToken: "t" })).status).toBe(400);
  expect(row().status).toBe("pending");
});

test("Turnstile failure and hostname mismatch are recorded, not approved", async () => {
  await hook(joinRequest({ query_id: "Q1" }));
  const data = await initData({ chat_join_request_query_id: "Q1" });
  turnstile = { success: true, hostname: "evil.example" };
  expect((await post("/api/verify", { initData: data, turnstileToken: "t" })).status).toBe(400);
  expect(row().turnstile_error).toBe("hostname-mismatch:evil.example");
  expect(row().status).toBe("pending");
});

test("transient Telegram error returns the attempt to pending", async () => {
  await hook(joinRequest({ query_id: "Q1" }));
  const data = await initData({ chat_join_request_query_id: "Q1" });
  failMethods.answerChatJoinRequestQuery = "Internal Server Error";
  expect((await post("/api/verify", { initData: data, turnstileToken: "t" })).status).toBe(502);
  expect(row().status).toBe("pending");
});

test("expiry declines both paths", async () => {
  await hook(joinRequest({ query_id: "Q1" }));
  await hook({ ...joinRequest(), update_id: 2 });
  calls = [];
  await expirePending(env, Date.now() + 11 * 60 * 1000);
  expect(calls.map((c) => c.method).sort()).toEqual([
    "answerChatJoinRequestQuery",
    "declineChatJoinRequest",
    "deleteMessage",
  ]);
  expect(calls.find((c) => c.method === "answerChatJoinRequestQuery")?.params.result).toBe("decline");
  expect(db.query("SELECT DISTINCT status FROM attempts").all()).toEqual([{ status: "expired" }]);
});

test("chat_member kicked labels the approved attempt", async () => {
  await hook(joinRequest({ query_id: "Q1" }));
  const data = await initData({ chat_join_request_query_id: "Q1" });
  await post("/api/verify", { initData: data, turnstileToken: "t" });
  await hook({
    update_id: 3,
    chat_member: { chat: { id: -100 }, new_chat_member: { status: "kicked", user: { id: 42 } } },
  });
  expect(row().banned_at).toBeGreaterThan(0);
});
