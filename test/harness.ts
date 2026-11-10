// A whole Kitan deployment in memory: the real Worker over SQLite (standing in
// for D1), with Telegram, Turnstile and lols.bot faked at the network edge.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSha256, toHex } from "../src/crypto";
import worker from "../src/index";
import { expirePending } from "../src/join";
import type { Env } from "../src/types";

const TOKEN = "123:test-bot-token";
const SECRET = "hook-secret";
export const ORIGIN = "https://kitan.example.workers.dev";

export interface Call {
  method: string;
  params: Record<string, any>;
}

// Enough of D1's prepare/bind/first/all/run for the Worker.
function d1(db: Database): D1Database {
  const statement = (sql: string, args: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.query(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: db.query(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: db.query(sql).run(...(args as never[])).changes } }),
  });
  return { prepare: (sql: string) => statement(sql, []) } as unknown as D1Database;
}

export class World {
  readonly db = new Database(":memory:");
  readonly env: Env;
  calls: Call[] = [];
  turnstile: { success: boolean; hostname?: string } = { success: true, hostname: new URL(ORIGIN).hostname };
  failMethods: Record<string, string> = {};
  lolsBanned = new Set<number>();
  admins: { id: number; is_bot?: boolean; status?: string; can_change_info?: boolean }[] = [];
  refuseDMs = false; // Telegram refuses the bot's private messages; group messages still go through
  lolsDown = false;
  private nextUpdate = 1;
  private nextMessage = 1;

  constructor() {
    const dir = join(import.meta.dir, "../migrations");
    for (const file of readdirSync(dir).sort()) this.db.exec(readFileSync(join(dir, file), "utf8"));
    this.env = {
      DB: d1(this.db),
      TELEGRAM_BOT_TOKEN: TOKEN,
      WEBHOOK_SECRET: SECRET,
      TURNSTILE_SITE_KEY: "site",
      TURNSTILE_SECRET_KEY: "secret",
    };
    globalThis.fetch = this.network.bind(this) as typeof fetch;
  }

  private async network(input: string | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    if (url.hostname === "challenges.cloudflare.com") return Response.json(this.turnstile);
    if (url.hostname === "api.lols.bot") {
      if (this.lolsDown) throw new Error("timeout");
      return Response.json({ ok: true, banned: this.lolsBanned.has(Number(url.searchParams.get("id"))) });
    }
    const method = url.pathname.split("/").pop()!;
    const params = JSON.parse(String(init?.body ?? "{}"));
    this.calls.push({ method, params });
    if (this.failMethods[method]) return Response.json({ ok: false, description: this.failMethods[method] });
    if (this.refuseDMs && method === "sendMessage" && Number(params.chat_id) > 0) {
      return Response.json({ ok: false, description: "Forbidden: bot can't initiate conversation with a user" });
    }
    const result =
      method === "sendMessage"
        ? { message_id: this.nextMessage++ }
        : method === "getMe"
          ? { id: 1, username: "test_bot" }
          : method === "getChatAdministrators"
            ? this.admins.map(({ status, can_change_info, ...user }) => ({
                status: status ?? "administrator",
                can_change_info: can_change_info ?? false,
                user,
              }))
            : true;
    return Response.json({ ok: true, result });
  }

  post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      this.env,
    );
  }

  operator(path: string, body: unknown = {}): Promise<Response> {
    return this.post(path, body, { "x-setup-key": SECRET });
  }

  hook(update: Record<string, unknown>): Promise<Response> {
    return this.post("/telegram", { update_id: this.nextUpdate++, ...update }, { "x-telegram-bot-api-secret-token": SECRET });
  }

  // A join request; a queryId makes it arrive on the guard-bot path.
  requestJoin(userId: number, chatId: number, opts: { queryId?: string; lang?: string } = {}): Promise<Response> {
    return this.hook({
      chat_join_request: {
        chat: { id: chatId, title: `chat${chatId}` },
        from: { id: userId, language_code: opts.lang },
        user_chat_id: userId,
        date: 0,
        query_id: opts.queryId,
      },
    });
  }

  say(userId: number, chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<Response> {
    return this.hook({
      message: { message_id: this.nextMessage++, chat: { id: chatId, type: "supergroup" }, from: { id: userId }, text, ...extra },
    });
  }

  // The person opens the bot and presses Start.
  startBot(userId: number): Promise<Response> {
    return this.hook({
      message: { message_id: this.nextMessage++, chat: { id: userId, type: "private" }, from: { id: userId }, text: "/start" },
    });
  }

  memberUpdate(userId: number, chatId: number, status: string): Promise<Response> {
    return this.hook({ chat_member: { chat: { id: chatId }, new_chat_member: { status, user: { id: userId } } } });
  }

  // Signed Mini App launch data, as Telegram gives it to that user's client.
  async initData(userId: number, fields: Record<string, string> = {}): Promise<string> {
    const params = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: userId }),
      ...fields,
    });
    const check = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    params.set("hash", toHex(await hmacSha256(await hmacSha256("WebAppData", TOKEN), check)));
    return params.toString();
  }

  // Opens the Mini App and submits a check, the way the page does. Returns the HTTP status.
  async completeCheck(userId: number, chatId: number): Promise<number> {
    const attempt = this.latestAttempt(userId, chatId);
    const data = attempt.query_id
      ? await this.initData(userId, { chat_join_request_query_id: attempt.query_id })
      : await this.initData(userId);
    const body = { initData: data, token: attempt.token ?? undefined };
    await this.post("/api/open", body);
    return (await this.post("/api/verify", { ...body, turnstileToken: "t", solveMs: 1500 })).status;
  }

  expire(at: number): Promise<void> {
    return expirePending(this.env, at);
  }

  latestAttempt(userId: number, chatId: number): Record<string, any> {
    return this.db
      .query("SELECT * FROM attempts WHERE user_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1")
      .get(String(userId), String(chatId)) as Record<string, any>;
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  callsTo(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
}
