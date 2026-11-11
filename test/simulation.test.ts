// Who Kitan meets, played against the real Worker. Each actor is a script of
// what that kind of account does; the table at the end is what Kitan did to
// each, including the known costs (a newcomer's first link) and gaps (spam
// posted after probation).
import { afterAll, expect, test } from "bun:test";
import { World } from "./harness";

const A = -100;
const B = -200;
const C = -300;
const DAY = 24 * 60 * 60 * 1000;
const outcomes: { actor: string; outcome: string }[] = [];

function record(actor: string, outcome: string) {
  outcomes.push({ actor, outcome });
}

// What Telegram was asked to do to one user, in order.
function actionsOn(w: World, userId: number): string[] {
  return w.calls.filter((c) => String(c.params.user_id) === String(userId)).map((c) => `${c.method}@${c.params.chat_id}`);
}

test("a person passes the check and chats normally", async () => {
  const w = new World();
  await w.requestJoin(1, A);
  expect(await w.completeCheck(1, A)).toBe(200);
  await w.say(1, A, "hi all, found this group through a friend");
  await w.say(1, A, "what's everyone working on?");
  expect(w.methods()).not.toContain("restrictChatMember");
  record("person", "approved; never moderated");
});

test("a person misses the DM, asks again, and gets more time", async () => {
  const w = new World();
  await w.requestJoin(2, A);
  await w.expire(Date.now() + 6 * 60 * 1000);
  expect(w.latestAttempt(2, A).status).toBe("expired");
  expect(w.methods()).toContain("declineChatJoinRequest");

  await w.requestJoin(2, A);
  const second = w.latestAttempt(2, A);
  expect(second.misses).toBe(1);
  expect(second.expires_at - second.created_at).toBe(15 * 60 * 1000);
  expect(await w.completeCheck(2, A)).toBe(200);
  record("person who misses the DM", "declined after 5 min; asks again with 15 min and passes");
});

test("a person whose privacy settings refuse the DM, then presses Start", async () => {
  const w = new World();
  w.failMethods.sendMessage = "Forbidden: bot can't initiate conversation with a user";
  await w.requestJoin(3, A);
  await w.requestJoin(3, B);
  await w.expire(Date.now() + 6 * 60 * 1000);
  expect(w.latestAttempt(3, A).status).toBe("unreachable");
  expect(w.methods()).not.toContain("declineChatJoinRequest");

  // Starting the bot opens the private chat, so the DMs go through.
  delete w.failMethods.sendMessage;
  w.calls = [];
  await w.startBot(3);
  expect(w.callsTo("sendMessage").map((c) => c.params.chat_id)).toEqual([3, 3]);
  expect(await w.completeCheck(3, A)).toBe(200);
  expect(await w.completeCheck(3, B)).toBe(200);
  record("person whose DMs are closed", "presses Start within the hour and passes");
});

test("a person whose DMs are closed and who never presses Start is not locked out", async () => {
  const w = new World();
  w.failMethods.sendMessage = "Forbidden: bot can't initiate conversation with a user";
  await w.requestJoin(14, A);
  await w.expire(Date.now() + 30 * 60 * 1000);
  expect(w.latestAttempt(14, A).status).toBe("unreachable");
  await w.expire(Date.now() + 61 * 60 * 1000);
  expect(w.latestAttempt(14, A).status).toBe("expired");
  expect(w.callsTo("declineChatJoinRequest")).toHaveLength(1);

  // Declined, so Telegram lets them ask again, and a new check starts.
  delete w.failMethods.sendMessage;
  await w.requestJoin(14, A);
  expect(w.latestAttempt(14, A).status).toBe("pending");
  record("person whose DMs are closed, never presses Start", "declined after an hour; can ask again");
});

test("pressing Start with nothing to resume explains the bot and offers to add it to a group", async () => {
  const w = new World();
  await w.startBot(13);
  const reply = w.callsTo("sendMessage")[0].params;
  expect(reply.text).toContain("You have no checks waiting");
  expect(reply.reply_markup.inline_keyboard[0][0].url).toBe(
    "https://t.me/test_bot?startgroup&admin=can_invite_users+can_delete_messages+can_restrict_members",
  );
});

test("lols.bot is down: people are still checked, not blocked", async () => {
  const w = new World();
  w.lolsDown = true;
  await w.requestJoin(4, A);
  expect(await w.completeCheck(4, A)).toBe(200);
  record("person, lols.bot unreachable", "approved (screening fails open)");
});

test("a simple bot that cannot run a browser", async () => {
  const w = new World();
  await w.requestJoin(5, A, { queryId: "Q5" });
  await w.expire(Date.now() + 11 * 60 * 1000);
  expect(w.latestAttempt(5, A).status).toBe("expired");
  record("script without a browser", "declined at the deadline");
});

test("a spam account already on lols.bot", async () => {
  const w = new World();
  w.lolsBanned.add(6);
  await w.requestJoin(6, A);
  expect(w.latestAttempt(6, A)).toMatchObject({ status: "declined", error: "lols_banned" });
  expect(w.methods()).toEqual(["declineChatJoinRequest"]);
  record("known spammer (lols.bot)", "declined at the door, never challenged");
});

test("a farm account that buys Turnstile solves, then advertises in two groups", async () => {
  const w = new World();
  for (const chat of [A, B]) {
    await w.requestJoin(7, chat);
    expect(await w.completeCheck(7, chat)).toBe(200);
  }
  w.calls = [];
  await w.say(7, A, "Earn $500/day, DM me t.me/quickcash");
  expect(actionsOn(w, 7)).toEqual([`restrictChatMember@${A}`]);
  await w.say(7, B, "", { forward_origin: { type: "channel" } });
  expect(w.callsTo("banChatMember").map((c) => c.params.chat_id).sort()).toEqual([String(A), String(B)]);

  w.calls = [];
  await w.requestJoin(7, C);
  expect(w.latestAttempt(7, C)).toMatchObject({ status: "declined", error: "kitan_blocklist" });
  record("solver-backed farm account", "muted on 1st ad, banned from A and B on 2nd, refused by C");
});

test("a farm account that pastes one ad into several groups", async () => {
  const w = new World();
  for (const chat of [A, B]) {
    await w.requestJoin(8, chat);
    await w.completeCheck(8, chat);
  }
  w.calls = [];
  await w.say(8, A, "Exclusive crypto signals, join our VIP room today");
  expect(w.calls).toHaveLength(0);
  await w.say(8, B, "exclusive  CRYPTO signals, join our VIP room today");
  expect(w.callsTo("banChatMember")).toHaveLength(2);
  record("copy-paste spammer (no links)", "banned from both groups on the 2nd paste");
});

test("a farm account on the guard-bot path", async () => {
  const w = new World();
  await w.requestJoin(9, A, { queryId: "Q9" });
  expect(await w.completeCheck(9, A)).toBe(200);
  await w.say(9, A, "@alice_x @bobby_y @carol_z @dave_w check this out");
  expect(w.methods()).toContain("restrictChatMember");
  record("mass-mention spammer (guard path)", "muted on the 1st mention flood");
});

test("cost: a real newcomer shares a link on day one", async () => {
  const w = new World();
  await w.requestJoin(10, A);
  await w.completeCheck(10, A);
  await w.say(10, A, "the docs are at https://example.org/guide");
  expect(w.methods()).toContain("restrictChatMember");
  expect(w.methods()).not.toContain("banChatMember");
  // Only they are told why, and until when, in their own time zone.
  const note = w.callsTo("sendMessage").find((c) => c.params.ephemeral_message_parameters);
  expect(note?.params).toMatchObject({ chat_id: String(A), parse_mode: "HTML", ephemeral_message_parameters: { receiver_user_id: 10 } });
  expect(note?.params.text).toMatch(/^Your message was removed because .* from ⁨<tg-time unix="\d+" format="dt">/);
  record("COST newcomer posting a link", "message deleted, muted for day one, told why privately");
});

test("gap: a spam account waits out probation before advertising", async () => {
  const w = new World();
  await w.requestJoin(11, A);
  await w.completeCheck(11, A);
  w.db.run("UPDATE attempts SET decided_at = decided_at - ? WHERE user_id = '11'", [DAY + 60_000]);
  w.calls = [];
  await w.say(11, A, "cheap followers t.me/spam");
  expect(w.calls).toHaveLength(0);
  record("GAP spammer patient for 24h", "not caught; needs admins or reports");
});

test("members who joined before Kitan are never touched", async () => {
  const w = new World();
  await w.say(12, A, "old-timer sharing https://example.org");
  expect(w.calls).toHaveLength(0);
  record("member from before Kitan", "never moderated");
});

afterAll(() => {
  console.log("\nSimulation outcomes");
  console.table(outcomes);
});
