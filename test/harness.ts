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
  bios = new Map<number, string>(); // what getChat returns for a user's profile
  // The model's reply, decided per call from what it was asked (the user message).
  model: (prompt: string, model: string) => Record<string, unknown> = () => ({ ad: false, confidence: 0.9, kind: "none", reason: "chat" });
  aiCalls: { model: string; prompt: string }[] = [];
  private background: Promise<unknown>[] = [];
  private nextUpdate = 1;
  private nextMessage = 1;

  constructor() {
    const dir = join(import.meta.dir, "../migrations");
    for (const file of readdirSync(dir).sort()) this.db.exec(readFileSync(join(dir, file), "utf8"));
    const ai = {
      run: async (model: string, input: { messages: { role: string; content: unknown }[] }) => {
        const user = input.messages.find((m) => m.role === "user")?.content;
        const prompt = typeof user === "string" ? user : JSON.stringify(user);
        this.aiCalls.push({ model, prompt });
        return { response: JSON.stringify(this.model(prompt, model)) };
      },
    };
    this.env = {
      DB: d1(this.db),
      AI: ai as unknown as Ai,
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
    if (url.pathname.startsWith("/file/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
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
            : method === "getChat" && Number(params.chat_id) > 0
              ? { id: params.chat_id, type: "private", bio: this.bios.get(Number(params.chat_id)) }
              : method === "getFile"
                ? { file_id: params.file_id, file_path: `photos/${params.file_id}.jpg` }
                : method === "getChatMember"
                  ? { status: this.admins.some((a) => a.id === Number(params.user_id)) ? "administrator" : "member" }
                  : true;
    return Response.json({ ok: true, result });
  }

  // Like the Workers runtime, but waits for work handed to waitUntil before returning,
  // so a test sees the shadow verdicts its update produced.
  async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const execution = { waitUntil: (work: Promise<unknown>) => this.background.push(work), passThroughOnException() {} };
    const response = await worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      this.env,
      execution as unknown as ExecutionContext,
    );
    while (this.background.length) await this.background.shift();
    return response;
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

  // A group message; returns its message id so a test can edit it later.
  async say(
    userId: number,
    chatId: number,
    text: string,
    extra: Record<string, unknown> = {},
    from: Record<string, unknown> = {},
  ): Promise<number> {
    const message_id = this.nextMessage++;
    await this.hook({
      message: { message_id, chat: { id: chatId, type: "supergroup" }, from: { id: userId, ...from }, text, ...extra },
    });
    return message_id;
  }

  edit(userId: number, chatId: number, messageId: number, text: string, from: Record<string, unknown> = {}): Promise<Response> {
    return this.hook({
      edited_message: {
        message_id: messageId,
        chat: { id: chatId, type: "supergroup" },
        from: { id: userId, ...from },
        text,
        edit_date: Math.floor(Date.now() / 1000),
      },
    });
  }

  // Someone joins the group, admitted by `by` (another bot, an admin) or on their own.
  join(userId: number, chatId: number, by: { id: number; is_bot?: boolean; username?: string } = { id: userId }, user: Record<string, unknown> = {}) {
    return this.hook({
      chat_member: {
        chat: { id: chatId, type: "supergroup" },
        from: by,
        old_chat_member: { status: "left", user: { id: userId, ...user } },
        new_chat_member: { status: "member", user: { id: userId, ...user } },
        via_join_request: by.id !== userId,
      },
    });
  }

  events(userId: number, kind?: string): { kind: string; detail: Record<string, any> }[] {
    const rows = this.db
      .query("SELECT kind, detail FROM events WHERE user_id = ? ORDER BY id")
      .all(String(userId)) as { kind: string; detail: string }[];
    return rows.filter((r) => !kind || r.kind === kind).map((r) => ({ kind: r.kind, detail: JSON.parse(r.detail) }));
  }

  // The person opens the bot and presses Start.
  startBot(userId: number): Promise<Response> {
    return this.hook({
      message: { message_id: this.nextMessage++, chat: { id: userId, type: "private" }, from: { id: userId }, text: "/start" },
    });
  }

  memberUpdate(userId: number, chatId: number, status: string, by = { id: 999, username: "an_admin" }): Promise<Response> {
    return this.hook({
      chat_member: {
        chat: { id: chatId },
        from: by,
        old_chat_member: { status: "member", user: { id: userId } },
        new_chat_member: { status, user: { id: userId } },
      },
    });
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
    const status = (await this.post("/api/verify", { ...body, turnstileToken: "t", solveMs: 1500 })).status;
    // Telegram reports the approval as the person joining, admitted by Kitan.
    if (status === 200) await this.join(userId, chatId, { id: 123, is_bot: true, username: "test_bot" });
    return status;
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
