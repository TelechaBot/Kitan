// Real incidents from a group's screenshots (2026-11-12), replayed against the real
// Worker. These pin down what the deterministic rules do and that the footprint
// records enough to reconstruct each case. Whether models catch them is measured
// by bench/, against the real models; the model here is a stand-in.
import { beforeEach, expect, test } from "bun:test";
import { empty, step } from "../src/trajectory";
import { World } from "./harness";

// An ordinary active account's sketch: 30 short messages a few hours apart.
function sketch(seed: number) {
  let t = empty();
  for (let i = 0; i < 30; i++) {
    t = step(t, { kind: "message", at: i * (3 + (seed % 5)) * 3_600_000, newChat: i === 0, link: false, mention: false, forward: false, media: false, chars: 10 + seed % 40 });
  }
  return t;
}

const GROUP = -1001;
// "Neutron Verify" in the screenshots is Kitan itself: these accounts passed the check.
const KITAN = { id: 123, is_bot: true, username: "test_bot" };
let w: World;

beforeEach(() => {
  w = new World();
});

test("greetings, deleted and re-posted, then gone: recorded, not actionable by rules", async () => {
  await w.join(21, GROUP, KITAN, { first_name: "晴晴 ❤️" });
  for (const text of ["大家好，我是来学习的，顺便摸个鱼", "大家好呀，刚加进来打个招呼", "打工人报到，今天也是不想上班的一天"]) {
    await w.say(21, GROUP, text, {}, { first_name: "晴晴 ❤️" });
  }
  await w.memberUpdate(21, GROUP, "left", { id: 21, username: "self" });
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
  expect(w.events(21).map((e) => e.kind)).toEqual(
    expect.arrayContaining(["join", "profile", "message", "verdict", "leave"]),
  );
  expect(w.events(21, "message").map((e) => e.detail.messages)).toEqual([1, 2, 3]);
});

test("passed Kitan's check, then a covert adult-services pitch: the decision leans ad, so the written verdict runs", async () => {
  w.decision = (prompt) => (prompt.includes("夜场") ? 0.9 : 0.01);
  await w.join(22, GROUP, KITAN, { first_name: "mugabula", last_name: "twaha" });
  await w.say(22, GROUP, "新人一枚，不太会说话，只会哈哈哈");
  await w.say(22, GROUP, "现在全国夜场都要倒闭了 我们女生赚钱越来越难了");
  expect(w.callsTo("deleteMessage")).toHaveLength(0); // rules miss it: no link, button or mention
  expect(w.events(22, "join")[0].detail.approved_by).toBe("bot:@test_bot");
  const [, pitch] = w.events(22, "verdict").filter((v) => v.detail.on === "message");
  expect(pitch.detail.decision.p).toBeCloseTo(0.9, 2);
  expect(pitch.detail.text_model).toMatchObject({ model: "@cf/qwen/qwen3-30b-a3b-fp8" });
});

test("a bot-username drop, posted and then edited: caught on the post and on the edit", async () => {
  await w.join(23, GROUP, KITAN, { first_name: "🌹 神财P图王" });
  const id = await w.say(23, GROUP, "@BSGJUU_bot", {}, { first_name: "🌹 神财P图王" });
  expect(w.callsTo("deleteMessage")).toHaveLength(1);
  await w.edit(23, GROUP, id, "@BSGJUUU_bot", { first_name: "🌹 神财P图王" });
  expect(w.callsTo("deleteMessage")).toHaveLength(2);
  expect(w.events(23, "edit")).toHaveLength(1);
  expect(w.events(23, "action").map((a) => a.detail.rule)).toEqual(["bot_promo", "bot_promo"]);
});

test("a flood that points elsewhere, from someone nobody talks with, is banned with all its copies", async () => {
  // 2026-11-12: "搞钱", in through an admin's invite link, posted "最新项目" 65 times in 3 hours.
  w.bios.set(34, "最新项目 小白可做 秒下款 公群：https://t.me/+abc");
  await w.join(34, GROUP, { id: 900, username: "an_admin" }, { first_name: "搞钱" });
  for (let i = 0; i < 3; i++) await w.say(34, GROUP, "最新项目");
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
  await w.say(34, GROUP, "最新项目");
  expect(w.callsTo("banChatMember").map((c) => c.params)).toEqual([{ chat_id: String(GROUP), user_id: "34", revoke_messages: true }]);
  expect(w.events(34, "action")[0].detail).toMatchObject({ rule: "repeated", action: "burn", pointsElsewhere: true, sociable: false });
});

test("a flood with nowhere to send people, or from someone others answer, is only muted", async () => {
  await w.join(44, GROUP, KITAN);
  for (let i = 0; i < 4; i++) await w.say(44, GROUP, "有人在吗？？");
  expect(w.callsTo("restrictChatMember")).toHaveLength(1);
  expect(w.callsTo("banChatMember")).toHaveLength(0);

  w.bios.set(45, "博客 https://example.org");
  await w.join(45, GROUP, KITAN);
  const id = await w.say(45, GROUP, "求助");
  await w.say(46, GROUP, "怎么了", { reply_to_message: { message_id: id, from: { id: 45 } } });
  for (let i = 0; i < 3; i++) await w.say(45, GROUP, "求助");
  expect(w.callsTo("restrictChatMember")).toHaveLength(2);
  expect(w.callsTo("banChatMember")).toHaveLength(0);
});

test("the same contact card again and again is a flood too", async () => {
  // 2026-11-12: "Clara", in through an admin's invite link, posted 140 contact cards in 4 hours.
  await w.join(38, GROUP, { id: 900, username: "an_admin" }, { first_name: "Clara" });
  for (let i = 0; i < 4; i++) {
    await w.say(38, GROUP, "", { contact: { phone_number: "+1 555 0100", first_name: "客服", user_id: 4242 } });
  }
  expect(w.callsTo("banChatMember")).toHaveLength(1); // a contact card is somewhere to go
  const verdict = w.events(38, "verdict").find((v) => v.detail.on === "message")!.detail;
  expect(verdict.dossier).toMatchObject({ kind: "contact", text: "[contact card: 客服]" });
  expect(JSON.stringify(w.events(38))).not.toContain("555");
});

test("a copy of what someone just sent is not judged by the models again", async () => {
  await w.join(39, GROUP, KITAN);
  await w.say(39, GROUP, "有人在吗");
  const asked = w.aiCalls.length;
  await w.say(39, GROUP, "有人在吗");
  expect(w.aiCalls).toHaveLength(asked);
  expect(w.events(39, "message")).toHaveLength(2);
});

test("being answered, answering and stickers are counted as social life", async () => {
  await w.join(40, GROUP, KITAN);
  const asked = await w.say(40, GROUP, "这个怎么配置？");
  await w.say(41, GROUP, "看置顶", { reply_to_message: { message_id: asked, from: { id: 40 } } });
  await w.say(40, GROUP, "谢谢！", { reply_to_message: { message_id: asked + 1, from: { id: 41 } } });
  await w.say(40, GROUP, "", { sticker: { file_id: "s1", emoji: "🙏" } });
  expect(w.events(40, "message").at(-1)?.detail.social).toEqual({ replies: 1, repliedBy: 1, stickers: 1 });
  // Replying to oneself or to a bot is not company.
  await w.say(40, GROUP, "补充一下", { reply_to_message: { message_id: asked, from: { id: 40 } } });
  expect(w.events(40, "message").at(-1)?.detail.social.replies).toBe(1);
});

test("the targets an account points people to are recorded with each verdict", async () => {
  w.bios.set(43, "最新项目 公群：https://t.me/+abc");
  await w.join(43, GROUP, { id: 900, username: "an_admin" });
  await w.say(43, GROUP, "看我主页");
  const verdict = w.events(43, "verdict").find((v) => v.detail.on === "message")!.detail;
  expect(verdict.targets.map((t: { kind: string; in: string }) => `${t.kind}@${t.in}`)).toEqual(["pointer@message", "invite@bio", "pointer@bio"]);
});

test("a person repeating a short question a few times is left alone", async () => {
  await w.join(35, GROUP, KITAN);
  for (let i = 0; i < 3; i++) await w.say(35, GROUP, "有人吗？");
  await w.say(35, GROUP, "666");
  await w.say(35, GROUP, "666");
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
});

test("an ad in the display name with a picture: the name and the image reach the detectors", async () => {
  await w.join(24, GROUP, KITAN, { first_name: "迅游群发器代发广告1" });
  await w.say(24, GROUP, "", { photo: [{ file_id: "p1", width: 320, height: 320 }, { file_id: "p2", width: 1280, height: 1280 }] }, {
    first_name: "迅游群发器代发广告1",
  });
  const verdict = w.events(24, "verdict").find((v) => v.detail.on === "message");
  expect(verdict?.detail.lexicon.name).toContain("代发");
  expect(verdict?.detail.image_model).toMatchObject({ model: "@cf/meta/llama-4-scout-17b-16e-instruct" });
  expect(w.aiCalls.some((c) => c.model.includes("llama-4-scout") && c.prompt.includes("data:image/jpeg;base64"))).toBe(true);
});

test("a newcomer's message is stored with the facts the rules read, and both model checks run", async () => {
  w.decision = (prompt) => (prompt.includes("夜场") ? 0.96 : 0.01);
  await w.join(26, GROUP, KITAN);
  await w.say(26, GROUP, "现在全国夜场都要倒闭了 https://x.example", { entities: [{ type: "url", offset: 14, length: 17 }] });
  expect(w.events(26, "message")[0].detail.facts).toMatchObject({ text: "现在全国夜场都要倒闭了 https://x.example", entities: [{ type: "url" }] });
  const verdict = w.events(26, "verdict").find((v) => v.detail.on === "message")?.detail;
  expect(verdict?.decision).toMatchObject({ model: "@cf/qwen/qwen3-30b-a3b-fp8" });
  expect(verdict?.decision.p).toBeCloseTo(0.96, 2);
});

test("photos are read at Telegram's ~320 px size", async () => {
  await w.join(27, GROUP, KITAN);
  await w.say(27, GROUP, "", { photo: [{ file_id: "s", width: 90, height: 90 }, { file_id: "m", width: 320, height: 320 }, { file_id: "y", width: 1280, height: 1280 }] });
  expect(w.callsTo("getFile").map((c) => c.params.file_id)).toEqual(["m"]);
});

const LINK = "see https://t.me/x";
const WEEK = 7 * 24 * 60 * 60 * 1000;

// Ages someone's join in every group, as if `ms` had passed.
function age(userId: number, ms: number) {
  w.db.run("UPDATE speakers SET joined_at = joined_at - ? WHERE user_id = ?", [ms, String(userId)]);
}

// A one-tree forest that sends everyone to a leaf of `leaf` rows: 1 scores ~0.92 (anomalous), 127 ~0.46.
function forestScoring(leaf: number) {
  const body = JSON.stringify({ sample: 128, trees: [{ nodes: [[0, 1e15, 1, 2], [-1, leaf], [-1, 128 - leaf]] }] });
  w.db.run("INSERT INTO models (name, trained_at, rows, body) VALUES ('trajectory_iforest', ?, 128, ?)", [Date.now(), body]);
}

test("a newcomer is reviewed however much they post: no posting out of review", async () => {
  await w.join(28, GROUP, KITAN);
  for (let i = 0; i < 25; i++) await w.say(28, GROUP, `hi ${i}`);
  await w.say(28, GROUP, LINK);
  expect(w.callsTo("deleteMessage")).toHaveLength(1);
  expect(w.events(28, "message").at(-1)?.detail.review).toBe("newcomer");
});

test("after a week, someone active across Kitan groups is left alone, even posting a link", async () => {
  forestScoring(127);
  await w.join(29, GROUP, KITAN);
  for (let i = 0; i < 21; i++) await w.say(29, GROUP, `hi ${i}`);
  age(29, WEEK + 60_000);
  const recorded = w.events(29).length;
  await w.say(29, GROUP, LINK);
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
  expect(w.events(29)).toHaveLength(recorded); // left alone: not even recorded
});

test("an active member whose behaviour turns anomalous is reviewed again", async () => {
  forestScoring(1);
  await w.join(30, GROUP, KITAN);
  for (let i = 0; i < 21; i++) await w.say(30, GROUP, `hi ${i}`);
  age(30, WEEK + 60_000);
  await w.say(30, GROUP, LINK);
  expect(w.callsTo("deleteMessage")).toHaveLength(1);
  expect(w.events(30, "message").at(-1)?.detail).toMatchObject({ review: "anomalous", anomaly: expect.any(Number) });
});

test("a quiet account past its first week is still reviewed", async () => {
  await w.join(33, GROUP, KITAN);
  await w.say(33, GROUP, "hi");
  age(33, WEEK + 60_000);
  await w.say(33, GROUP, LINK);
  expect(w.callsTo("deleteMessage")).toHaveLength(1);
  expect(w.events(33, "message").at(-1)?.detail.review).toBe("quiet");
});

test("the hourly job trains the forest on active accounts once a day", async () => {
  for (let u = 0; u < 130; u++) {
    w.db.run("INSERT INTO trajectories (user_id, messages, updated_at, body) VALUES (?, 30, 0, ?)", [
      String(5e9 + u * 1e6),
      JSON.stringify(sketch(u)),
    ]);
  }
  await w.hourly();
  const model = w.db.query("SELECT rows FROM models WHERE name = 'trajectory_iforest'").get() as { rows: number } | null;
  expect(model?.rows).toBe(130);
});

test("the profile is read at join: bio and who admitted them", async () => {
  w.bios.set(25, "日入过万 私我进群");
  await w.join(25, GROUP, KITAN, { first_name: "景初" });
  expect(w.events(25, "profile")[0].detail).toMatchObject({ bio: "日入过万 私我进群", name: "景初" });
  const verdict = w.events(25, "verdict")[0].detail;
  expect(verdict.lexicon).toEqual(expect.arrayContaining(["私我进群"]));
  expect(verdict.dossier).toMatchObject({ bio: "日入过万 私我进群", admittedBy: "Kitan's check (a captcha)", minutesSinceJoin: 0 });
});

test("every model sees the sender's file: group title, bio, how they came in, what they sent", async () => {
  w.bios.set(36, "拿货联系 @x 公群 https://t.me/+abc");
  await w.hook({
    chat_member: {
      chat: { id: GROUP, type: "supergroup", title: "数码交流群" },
      from: { id: 36 },
      old_chat_member: { status: "left", user: { id: 36, first_name: "Jay" } },
      new_chat_member: { status: "member", user: { id: 36, first_name: "Jay" } },
      invite_link: { name: "Leah baby", creator: { id: 900, username: "an_admin" } },
    },
  });
  await w.say(36, GROUP, "", { video: { file_id: "v", duration: 9, thumbnail: { file_id: "thumb", width: 320, height: 180 } } }, { first_name: "Jay" });
  const verdict = w.events(36, "verdict").find((v) => v.detail.on === "message")!.detail;
  expect(verdict.dossier).toMatchObject({
    group: "数码交流群",
    bio: "拿货联系 @x 公群 https://t.me/+abc",
    admittedBy: 'invite link "Leah baby" made by user:@an_admin',
    kind: "video",
    messages: 1,
  });
  expect(w.callsTo("getFile").map((c) => c.params.file_id)).toEqual(["thumb"]);
  expect(w.aiCalls.find((c) => c.prompt.includes("message (video)"))?.prompt).toContain("bio: 拿货联系");
  expect(w.events(36, "message")[0].detail.facts).toMatchObject({ kind: "video", media: { duration: 9 } });
  expect(w.callsTo("getChat")).toHaveLength(1); // read at join, reused at the message
});

test("join, leave and pin notices are not counted as anything a member said", async () => {
  await w.join(37, GROUP, KITAN);
  await w.hook({ message: { message_id: 950, chat: { id: GROUP, type: "supergroup" }, from: { id: 37 }, new_chat_members: [{ id: 37 }] } });
  expect(w.events(37, "message")).toHaveLength(0);
  expect(w.db.query("SELECT messages FROM trajectories WHERE user_id = '37'").get()).toEqual({ messages: 0 });
});

test("link-button ads from a bot and a channel identity are removed; an active member's never are", async () => {
  const buttons = { reply_markup: { inline_keyboard: [[{ text: "进群领福利", url: "https://t.me/+abc" }]] } };
  await w.say(31, GROUP, "福利群", buttons, { is_bot: true, username: "promo_bot" });
  await w.hook({
    message: { message_id: 900, chat: { id: GROUP, type: "supergroup" }, sender_chat: { id: -100555, title: "福利频道" }, from: { id: 136817688, is_bot: true }, text: "看这里", ...buttons },
  });
  await w.say(32, GROUP, "推荐", { ...buttons, via_bot: { username: "some_inline_bot" } });
  expect(w.callsTo("deleteMessage")).toHaveLength(2);
  expect(w.callsTo("banChatMember").map((c) => c.params.user_id)).toEqual([31]);
  expect(w.callsTo("banChatSenderChat").map((c) => c.params.sender_chat_id)).toEqual([-100555]);
  expect(w.events(32)).toHaveLength(0); // not on probation: not even recorded
});

test("admins and the group's own channel posts keep their buttons", async () => {
  const buttons = { reply_markup: { inline_keyboard: [[{ text: "公告", url: "https://example.org" }]] } };
  w.admins = [{ id: 40 }];
  await w.say(40, GROUP, "群公告", buttons);
  await w.hook({
    message: { message_id: 901, chat: { id: GROUP, type: "supergroup" }, sender_chat: { id: -100777 }, is_automatic_forward: true, from: { id: 777000 }, text: "频道更新", ...buttons },
  });
  await w.hook({
    message: { message_id: 902, chat: { id: GROUP, type: "supergroup" }, sender_chat: { id: GROUP }, from: { id: 1087968824, is_bot: true }, text: "匿名管理员", ...buttons },
  });
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
});
