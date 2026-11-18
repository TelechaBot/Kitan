// Wiring and security edges of the Worker: what crosses HTTP and what Telegram is asked to do.
// Whole user journeys and adversaries live in simulation.test.ts.
import { beforeEach, expect, test } from "bun:test";
import { MESSAGES } from "../src/i18n";
import { ORIGIN, World, answerFor, readStep, readVerify } from "./harness";

const USER = 42;
const CHAT = -100;
let w: World;

beforeEach(() => {
  w = new World();
});

test("the webhook rejects a wrong secret", async () => {
  const response = await w.post("/telegram", { update_id: 1 }, { "x-telegram-bot-api-secret-token": "guess" });
  expect(response.status).toBe(401);
  expect(w.calls).toHaveLength(0);
});

test("operator endpoints need the setup key", async () => {
  expect((await w.post("/setup", {})).status).toBe(401);
  expect((await w.post("/status", {}, { "x-setup-key": "guess" })).status).toBe(401);
});

test("guard path: Telegram opens the Mini App, the page shows the group, approval answers the query", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  expect(w.calls).toEqual([
    // The profile is read before the check, so an ad bio can be audited first.
    { method: "getChat", params: { chat_id: USER } },
    { method: "sendChatJoinRequestWebApp", params: { chat_join_request_query_id: "Q1", web_app_url: `${ORIGIN}/` } },
  ]);
  const data = await w.initData(USER, { chat_join_request_query_id: "Q1" });
  expect(await (await w.post("/api/open", { initData: data })).json()).toMatchObject({ chat_title: `chat${CHAT}` });
  expect((await w.post("/api/verify", { initData: data, turnstileToken: "t", solveMs: 1800 })).status).toBe(200);
  expect(w.calls.at(-1)).toEqual({
    method: "answerChatJoinRequestQuery",
    params: { chat_join_request_query_id: "Q1", result: "approve" },
  });
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "approved", tries: 1, solve_ms: 1800 });
  expect((await w.post("/api/verify", { initData: data, turnstileToken: "t" })).status).toBe(409);
});

test("a redelivered guard query is handled once", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  expect(w.callsTo("sendChatJoinRequestWebApp")).toHaveLength(1);
});

test("DM path: the button carries a token, approval cleans up the message", async () => {
  await w.requestJoin(USER, CHAT);
  const token = w.latestAttempt(USER, CHAT).token;
  expect(w.callsTo("sendMessage")[0].params.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`${ORIGIN}/?token=${token}`);
  expect(await w.completeCheck(USER, CHAT)).toBe(200);
  const joinFlow = ["sendMessage", "approveChatJoinRequest", "declineChatJoinRequest", "deleteMessage"];
  expect(w.methods().filter((m) => joinFlow.includes(m))).toEqual(["sendMessage", "approveChatJoinRequest", "deleteMessage"]);
});

test("the DM speaks the requester's language", async () => {
  await w.requestJoin(USER, CHAT, { lang: "zh-hans" });
  const dm = w.callsTo("sendMessage")[0];
  expect(dm.params.text).toContain(`谢谢你申请加入「⁨chat${CHAT}⁩」`);
  expect(dm.params.reply_markup.inline_keyboard[0][0].text).toBe("开始验证");
});

test("an ad bio is declined with the reason every time it asks; no check is offered", async () => {
  w.decision = () => 0.95;
  w.model = () => ({ ad: true, confidence: 0.9, kind: "diversion", reason: "invite in the bio" });
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "私我 t.me/+abc", lang: "zh-hans" });
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "declined", error: "ad_profile" });
  expect(w.events(USER, "verdict")[0].detail).toMatchObject({ on: "join_request", verdict: "ad", decision: { p: 0.95 }, outcome: "declined" });
  // The reason goes out while the bot may still write to them, before the decline.
  const told = w.methods().indexOf("sendMessage");
  expect(told).toBeGreaterThanOrEqual(0);
  expect(w.methods().indexOf("answerChatJoinRequestQuery")).toBeGreaterThan(told);
  expect(w.callsTo("sendMessage")[0].params).toMatchObject({ chat_id: USER });
  expect(w.callsTo("sendMessage")[0].params.text).toContain("修改后重新申请");
  expect(w.callsTo("answerChatJoinRequestQuery")[0].params).toEqual({ chat_join_request_query_id: "Q1", result: "decline" });

  await w.requestJoin(USER, CHAT, { queryId: "Q2", bio: "私我 t.me/+abc" });
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "declined", error: "ad_profile" });
  expect(w.callsTo("sendChatJoinRequestWebApp")).toHaveLength(0);
});

test("a suspect profile gets two Turnstile checks and a sum, in a shuffled order", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q2", bio: "日入过万" });
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "pending" });
  expect(w.latestAttempt(USER, CHAT).challenge).not.toBeNull();

  const data = await w.initData(USER, { chat_join_request_query_id: "Q2" });
  const opened = await w.post("/api/open", { initData: data });
  expect(opened.status).toBe(200);
  let step = readStep(await opened.json());
  expect(step).toBeDefined();
  const kinds: string[] = [];
  for (let i = 0; i < 3; i++) {
    expect(step).toBeDefined();
    kinds.push(step!.kind);
    if (step!.kind === "math") {
      // A wrong sum is refused with a fresh question, not a dead end.
      const wrong = await w.post("/api/verify", { initData: data, answer: 1_000_000, solveMs: 900 });
      expect(wrong.status).toBe(400);
      const fresh = readStep(await wrong.json());
      expect(fresh?.kind).toBe("math");
      const right = await w.post("/api/verify", { initData: data, answer: answerFor(fresh!.question!), solveMs: 900 });
      expect(right.status).toBe(200);
      const result = readVerify(await right.json());
      if (result.done !== false) break;
      step = result.step;
    } else {
      const response = await w.post("/api/verify", { initData: data, turnstileToken: "t", solveMs: 900 });
      expect(response.status).toBe(200);
      const result = readVerify(await response.json());
      if (result.done !== false) break;
      step = result.step;
    }
  }
  expect(kinds.filter((kind) => kind === "cf")).toHaveLength(2);
  expect(kinds.filter((kind) => kind === "math")).toHaveLength(1);
  expect(w.latestAttempt(USER, CHAT).status).toBe("approved");
  expect(w.calls.at(-1)).toEqual({
    method: "answerChatJoinRequestQuery",
    params: { chat_join_request_query_id: "Q2", result: "approve" },
  });
});

test("the audit reads the profile when the request has no bio", async () => {
  w.bios.set(USER, "最新项目 公群 https://t.me/+abc");
  w.decision = () => 0.97;
  w.model = () => ({ ad: true, confidence: 0.95, kind: "diversion", reason: "ad profile" });
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  expect(w.callsTo("getChat").length).toBeGreaterThan(0);
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "declined", error: "ad_profile" });
});

test("a clean bio keeps the ordinary single check", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "here for the art" });
  expect(w.latestAttempt(USER, CHAT).challenge).toBeNull();
  expect(w.aiCalls).toHaveLength(0);
  const data = await w.initData(USER, { chat_join_request_query_id: "Q1" });
  const opened = await w.post("/api/open", { initData: data });
  expect(readStep(await opened.json())).toBeUndefined();
  const passed = await w.post("/api/verify", { initData: data, turnstileToken: "t" });
  expect(passed.status).toBe(200);
  expect(readVerify(await passed.json()).done).toBeUndefined();
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "approved", challenge: null });
});

test("a spent model budget gives a profile that points somewhere the strict check, not a free pass", async () => {
  w.decision = () => 0.99;
  w.model = () => ({ ad: true, confidence: 0.99, kind: "diversion", reason: "ad" });
  w.db.run("INSERT INTO spend (hour, neurons) VALUES (?, 7000)", [Math.floor(Date.now() / 3_600_000)]);
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "私我 t.me/+abc" });
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "pending" });
  expect(w.latestAttempt(USER, CHAT).challenge).not.toBeNull();
  expect(w.aiCalls).toHaveLength(0);
  expect(w.events(USER, "verdict")[0].detail).toMatchObject({ verdict: "suspect", missing: ["text"] });
});

test("an audit left incomplete is finished before approval: an ad is refused even after passing", async () => {
  w.decision = () => 0.99;
  w.model = () => ({ ad: true, confidence: 0.99, kind: "diversion", reason: "ad" });
  w.db.run("INSERT INTO spend (hour, neurons) VALUES (?, 7000)", [Math.floor(Date.now() / 3_600_000)]);
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "私我 t.me/+abc" });
  expect(JSON.parse(w.latestAttempt(USER, CHAT).challenge).recheck).toBe(true);
  // The budget frees up while they solve the check; the finished audit reads an ad.
  w.db.run("DELETE FROM spend");
  w.bios.set(USER, "私我 t.me/+abc");
  expect(await w.completeCheck(USER, CHAT)).toBe(403);
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "declined", error: "ad_profile" });
  expect(w.callsTo("answerChatJoinRequestQuery").at(-1)!.params.result).toBe("decline");
  expect(w.events(USER, "verdict").at(-1)!.detail).toMatchObject({ on: "recheck", verdict: "ad" });
});

test("an incomplete audit that finishes clean lets the person in", async () => {
  w.db.run("INSERT INTO spend (hour, neurons) VALUES (?, 7000)", [Math.floor(Date.now() / 3_600_000)]);
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "my blog https://example.org" });
  w.db.run("DELETE FROM spend");
  w.bios.set(USER, "my blog https://example.org");
  expect(await w.completeCheck(USER, CHAT)).toBe(200);
  expect(w.latestAttempt(USER, CHAT).status).toBe("approved");
});

test("a model that errors is unknown, not clean", async () => {
  w.model = () => {
    throw new Error("upstream 500");
  };
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "私我 t.me/+abc" });
  expect(w.latestAttempt(USER, CHAT).challenge).not.toBeNull();
});

test("both signals must be confident: an ad verdict alone does not decline", async () => {
  w.decision = () => 0.95;
  w.model = () => ({ ad: true, confidence: 0.5, kind: "diversion", reason: "not sure" });
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "私我 t.me/+abc" });
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "pending", challenge: null });
});

test("a listed word alone is suspect: the strict check, not a decline; with a confident model, a decline", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "日入过万 私我" });
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "pending" });
  expect(w.latestAttempt(USER, CHAT).challenge).not.toBeNull();
  expect(w.events(USER, "verdict")[0].detail).toMatchObject({ on: "join_request", lexicon: ["日入过万"], verdict: "suspect" });

  w.decision = () => 0.95;
  w.model = () => ({ ad: true, confidence: 0.9, kind: "direct", reason: "money offer" });
  await w.requestJoin(43, CHAT, { queryId: "Q2", bio: "日入过万 私我" });
  expect(w.latestAttempt(43, CHAT)).toMatchObject({ status: "declined", error: "ad_profile" });
});

test("a fan group's owner who asks people to DM for the invite is not turned away", async () => {
  // 2026-11: this bio matched 私密群 and its owner, a regular, had to lift a mute.
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "赛马娘群已更改为私密群组，需要邀请链接的请私聊，但是入群有验证题。" });
  expect(w.latestAttempt(USER, CHAT).status).toBe("pending");
});

test("betting 'inside tips' names are on the keyword list, however they are spaced", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "足球，篮 球*一手内-幕" });
  expect(w.events(USER, "verdict")[0].detail).toMatchObject({ lexicon: ["一手内幕"], verdict: "suspect" });
  expect(w.latestAttempt(USER, CHAT).challenge).not.toBeNull();
  await w.requestJoin(43, CHAT, { queryId: "Q2" });
  expect(w.latestAttempt(43, CHAT)).toMatchObject({ status: "pending", challenge: null });
});

test("a bare domain in the bio points somewhere, so the models read it", async () => {
  w.decision = () => 0.97;
  w.model = () => ({ ad: true, confidence: 0.95, kind: "direct", reason: "ad agency site" });
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "黑鹰广告合作官方网站： heiying.co" });
  expect(w.events(USER, "verdict")[0].detail.targets).toEqual([{ kind: "link", in: "bio", value: "heiying.co" }]);
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "declined", error: "ad_profile" });
});

test("an ad avatar is declined even with a clean bio; an ordinary avatar is not", async () => {
  w.avatars.set(USER, [{ file_id: "av_s", width: 160, height: 160 }, { file_id: "av_m", width: 320, height: 320 }]);
  w.model = () => ({ ad: true, confidence: 0.95, kind: "diversion", reason: "QR code to group", transcript: "扫码进群" });
  await w.requestJoin(USER, CHAT, { queryId: "Q1", bio: "hello" });
  expect(w.callsTo("getFile").map((c) => c.params.file_id)).toEqual(["av_m"]);
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "declined", error: "ad_profile" });
  expect(w.events(USER, "verdict")[0].detail).toMatchObject({ on: "join_request", verdict: "ad", avatar_model: { ad: true } });

  const other = 43;
  w.avatars.set(other, [{ file_id: "av_ok", width: 320, height: 320 }]);
  w.model = () => ({ ad: false, confidence: 0.96, kind: "none", reason: "anime portrait" });
  await w.requestJoin(other, CHAT, { queryId: "Q2", bio: "hello" });
  expect(w.latestAttempt(other, CHAT)).toMatchObject({ status: "pending", challenge: null });
});

test("every language has every message", () => {
  const keys = Object.keys(MESSAGES.en).sort();
  for (const [lang, messages] of Object.entries(MESSAGES)) {
    expect([lang, Object.keys(messages).sort()]).toEqual([lang, keys]);
  }
});

test("one user cannot submit another user's check", async () => {
  await w.requestJoin(USER, CHAT);
  const token = w.latestAttempt(USER, CHAT).token;
  const response = await w.post("/api/verify", { initData: await w.initData(7), token, turnstileToken: "t" });
  expect(response.status).toBe(404);
});

test("forged launch data is rejected and changes nothing", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  const data = (await w.initData(USER, { chat_join_request_query_id: "Q1" })).replace(/hash=\w+/, "hash=00");
  expect((await w.post("/api/verify", { initData: data, turnstileToken: "t" })).status).toBe(400);
  expect(w.latestAttempt(USER, CHAT).status).toBe("pending");
});

test("a Turnstile token issued for another site is recorded and refused", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  w.turnstile = { success: true, hostname: "evil.example" };
  expect(await w.completeCheck(USER, CHAT)).toBe(400);
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "pending", turnstile_error: "hostname-mismatch:evil.example" });
});

test("a Telegram outage during approval lets the user retry", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  w.failMethods.answerChatJoinRequestQuery = "Internal Server Error";
  expect(await w.completeCheck(USER, CHAT)).toBe(502);
  expect(w.latestAttempt(USER, CHAT).status).toBe("pending");
  delete w.failMethods.answerChatJoinRequestQuery;
  expect(await w.completeCheck(USER, CHAT)).toBe(200);
});

test("a request withdrawn before approval fails cleanly", async () => {
  await w.requestJoin(USER, CHAT);
  w.failMethods.approveChatJoinRequest = "Bad Request: HIDE_REQUESTER_MISSING";
  expect(await w.completeCheck(USER, CHAT)).toBe(410);
  expect(w.latestAttempt(USER, CHAT).status).toBe("failed");
});

test("a failed Mini App launch goes to the admins, and is declined directly after an hour", async () => {
  w.failMethods.sendChatJoinRequestWebApp = "Bad Request";
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  expect(w.calls.at(-1)).toEqual({
    method: "answerChatJoinRequestQuery",
    params: { chat_join_request_query_id: "Q1", result: "queue" },
  });
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "queued", error: "sendChatJoinRequestWebApp: Bad Request" });

  w.calls = [];
  await w.expire(Date.now() + 61 * 60 * 1000);
  expect(w.calls).toEqual([
    { method: "declineChatJoinRequest", params: { chat_id: String(CHAT), user_id: String(USER) } },
  ]);
});

test("expiry declines both paths and removes the DM", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  await w.requestJoin(USER, -200);
  w.calls = [];
  await w.expire(Date.now() + 11 * 60 * 1000);
  expect(w.methods().sort()).toEqual(["answerChatJoinRequestQuery", "declineChatJoinRequest", "deleteMessage"]);
  expect(w.callsTo("answerChatJoinRequestQuery")[0].params.result).toBe("decline");
  expect(w.db.query("SELECT DISTINCT status FROM attempts").all()).toEqual([{ status: "expired" }]);
});

test("the admin notice goes to the owner only: dry run sends nothing, DM first, never twice", async () => {
  await w.requestJoin(USER, CHAT);
  w.admins = [{ id: 900, status: "creator" }, { id: 901, is_bot: true }, { id: 902, can_change_info: true }, { id: 903 }];
  w.calls = [];

  const report = async (body: unknown = {}) => (await (await w.operator("/notify-admins", body)).json()) as any;
  const dry = await report();
  expect(dry.groups).toEqual([{ group: `chat${CHAT}`, admins: 1, already_notified: 0, to_notify: 1 }]);
  expect(w.callsTo("sendMessage")).toHaveLength(0);

  const first = await report({ send: true });
  expect(first.groups[0]).toMatchObject({ dm: 1, ephemeral: 0, failed: 0 });
  expect(w.callsTo("sendMessage")[0].params).toMatchObject({ chat_id: "900" });
  expect(w.callsTo("sendMessage")[0].params.text).toContain("Guard bot mode");

  w.calls = [];
  expect((await report({ send: true })).groups[0]).toMatchObject({ already_notified: 1, dm: 0 });
  expect(w.callsTo("sendMessage")).toHaveLength(0);
});

test("without a listed owner, the notice goes to admins who can change settings, in the group if DMs are closed", async () => {
  await w.requestJoin(USER, CHAT);
  w.admins = [{ id: 902, can_change_info: true }, { id: 903 }];
  w.refuseDMs = true;
  w.calls = [];
  const sent = (await (await w.operator("/notify-admins", { send: true })).json()) as any;
  expect(sent.groups[0]).toMatchObject({ admins: 1, ephemeral: 1 });
  const ephemeral = w.callsTo("sendMessage").find((c) => c.params.ephemeral_message_parameters);
  expect(ephemeral?.params).toMatchObject({ chat_id: String(CHAT), ephemeral_message_parameters: { receiver_user_id: 902 } });
});

test("a member banned after approval is labelled for measurement", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  await w.completeCheck(USER, CHAT);
  await w.memberUpdate(USER, CHAT, "kicked");
  expect(w.latestAttempt(USER, CHAT).banned_at).toBeGreaterThan(0);
});
