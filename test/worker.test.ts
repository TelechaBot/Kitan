// Wiring and security edges of the Worker: what crosses HTTP and what Telegram is asked to do.
// Whole user journeys and adversaries live in simulation.test.ts.
import { beforeEach, expect, test } from "bun:test";
import { MESSAGES } from "../src/i18n";
import { ORIGIN, World } from "./harness";

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
  expect(w.calls[0].params.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`${ORIGIN}/?token=${token}`);
  expect(await w.completeCheck(USER, CHAT)).toBe(200);
  expect(w.methods()).toEqual(["sendMessage", "approveChatJoinRequest", "deleteMessage"]);
});

test("the DM speaks the requester's language", async () => {
  await w.requestJoin(USER, CHAT, { lang: "zh-hans" });
  expect(w.calls[0].params.text).toContain(`谢谢你申请加入「⁨chat${CHAT}⁩」`);
  expect(w.calls[0].params.reply_markup.inline_keyboard[0][0].text).toBe("开始验证 ✨");
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

test("a failed Mini App launch hands the request to admins", async () => {
  w.failMethods.sendChatJoinRequestWebApp = "Bad Request";
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  expect(w.calls.at(-1)).toEqual({
    method: "answerChatJoinRequestQuery",
    params: { chat_join_request_query_id: "Q1", result: "queue" },
  });
  expect(w.latestAttempt(USER, CHAT)).toMatchObject({ status: "failed", error: "sendChatJoinRequestWebApp: Bad Request" });
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

test("a member banned after approval is labelled for measurement", async () => {
  await w.requestJoin(USER, CHAT, { queryId: "Q1" });
  await w.completeCheck(USER, CHAT);
  await w.memberUpdate(USER, CHAT, "kicked");
  expect(w.latestAttempt(USER, CHAT).banned_at).toBeGreaterThan(0);
});
