// Real incidents from a group's screenshots (2026-11-12), replayed against the real
// Worker. These pin down what the deterministic rules do and that the footprint
// records enough to reconstruct each case. Whether models catch them is measured
// by bench/, against the real models; the model here is a stand-in.
import { beforeEach, expect, test } from "bun:test";
import { noticeInviteLinks } from "../src/notice";
import { World } from "./harness";

const GROUP = -1001;
const OTHER = -2002;
const DAY = 24 * 60 * 60 * 1000;
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
  w.bios.set(22, "私我");
  await w.join(22, GROUP, KITAN, { first_name: "mugabula", last_name: "twaha" });
  await w.say(22, GROUP, "新人一枚，不太会说话，只会哈哈哈");
  await w.say(22, GROUP, "现在全国夜场都要倒闭了 我们女生赚钱越来越难了");
  expect(w.callsTo("deleteMessage")).toHaveLength(0); // rules miss it: no diversion link, button or mention
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

test("a flood whose own text points elsewhere is banned, though the profile is blank", async () => {
  // 2026-11-13: "فرح", no bio, rotated counterfeit-money ads, each ending in "@chunqiu0099".
  await w.join(51, GROUP, { id: 900, username: "an_admin" }, { first_name: "فرح" });
  for (let i = 0; i < 4; i++) await w.say(51, GROUP, "假钞 假钞 假钞！！ 包过BC验钞机的假钞！可线下面交！  @chunqiu0099");
  expect(w.events(51, "action")[0].detail).toMatchObject({ rule: "repeated", action: "burn", score: 5, pointsElsewhere: true });
});

test("a Telegram link's own target is not counted twice", async () => {
  await w.join(52, GROUP, KITAN);
  await w.say(52, GROUP, "the docs are at t.me/guide");
  expect(w.events(52, "action")[0].detail).toMatchObject({ rule: "link", action: "mute", score: 1, pointsElsewhere: false });
});

test("a flood with nowhere to send people, or from someone others answer, is only muted", async () => {
  await w.join(44, GROUP, KITAN);
  for (let i = 0; i < 4; i++) await w.say(44, GROUP, "有人在吗？？");
  expect(w.callsTo("restrictChatMember")).toHaveLength(1);
  expect(w.callsTo("banChatMember")).toHaveLength(0);

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

test("the models are asked only when their answer could matter, and within the day's budget", async () => {
  // Nowhere to send people: no ad to act on, so no paid call.
  await w.join(47, GROUP, KITAN);
  await w.say(47, GROUP, "大家好");
  expect(w.aiCalls).toHaveLength(0);
  expect(w.events(47, "verdict").map((v) => v.detail.skipped)).toEqual(["no_target", "no_target"]);

  // Pointing somewhere: the profile and three distinct messages, then enough is known.
  w.bios.set(48, "公群 https://t.me/+abc");
  await w.join(48, GROUP, KITAN);
  for (const text of ["一", "二", "三", "四"]) await w.say(48, GROUP, text);
  expect(w.events(48, "verdict").map((v) => v.detail.skipped ?? "asked")).toEqual(["asked", "asked", "asked", "asked", "judged_enough"]);

  // Near the day's allowance, nothing more is asked.
  w.db.run("UPDATE spend SET neurons = 6999");
  w.bios.set(49, "公群 https://t.me/+abc");
  await w.join(49, GROUP, KITAN);
  expect(w.events(49, "verdict")[0].detail.skipped).toBe("budget");
});

test("an offer with nowhere to point is the keyword layer's: muted without asking a model", async () => {
  // 2026-11-13: "蛋糕（软乎乎）" posted only "可约".
  await w.join(50, GROUP, KITAN, { first_name: "蛋糕（软乎乎）" });
  await w.say(50, GROUP, "可约");
  expect(w.callsTo("restrictChatMember")).toHaveLength(1);
  expect(w.events(50, "action")[0].detail).toMatchObject({ rule: "keyword", action: "mute", words: ["可约"] });
  expect(w.aiCalls).toHaveLength(0);
});

test("rarely, an invite link that brings mostly ads earns its owner one quiet note", async () => {
  // People who join through an invite link skip the check by design; four links on
  // 2026-11-13 brought 85 people in a week, 69 of them ad accounts.
  const viaLink = (userId: number, chatId: number, link: string) =>
    w.hook({
      chat_member: {
        chat: { id: chatId, type: "supergroup", title: "牛仔资本" },
        from: { id: userId },
        old_chat_member: { status: "left", user: { id: userId } },
        new_chat_member: { status: "member", user: { id: userId } },
        invite_link: { name: link, creator: { id: 900, username: "an_admin" } },
      },
    });
  for (let i = 0; i < 12; i++) {
    await viaLink(600 + i, GROUP, "Leah baby");
    if (i < 10) await w.say(600 + i, GROUP, "日赚五百 t.me/spam");
  }
  for (let i = 0; i < 9; i++) {
    await viaLink(700 + i, OTHER, "小🐯");
    await w.say(700 + i, OTHER, "日赚五百 t.me/spam");
  }
  w.admins = [{ id: 900, status: "creator" }, { id: 901 }];
  w.calls = [];
  await noticeInviteLinks(w.env, Date.now());
  const notes = w.callsTo("sendMessage");
  expect(notes.map((n) => n.params.chat_id)).toEqual(["900"]); // the owner, by DM; the 9-of-9 link is below the bar
  expect(notes[0].params.text).toContain('"Leah baby", made by @an_admin: 12 joined, 10 removed or muted');

  w.calls = [];
  await noticeInviteLinks(w.env, Date.now() + DAY);
  expect(w.callsTo("sendMessage")).toHaveLength(0); // not again within 30 days
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
  w.bios.set(24, "代发联系 @xunyou_ad");
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
  w.bios.set(27, "进群 https://t.me/+x");
  await w.join(27, GROUP, KITAN);
  await w.say(27, GROUP, "", { photo: [{ file_id: "s", width: 90, height: 90 }, { file_id: "m", width: 320, height: 320 }, { file_id: "y", width: 1280, height: 1280 }] });
  expect(w.callsTo("getFile").map((c) => c.params.file_id)).toEqual(["m"]);
});

const recentOf = (userId: number, chatId: number): number[] => {
  const row = w.db
    .query("SELECT recent_ats FROM speakers WHERE chat_id = ? AND user_id = ?")
    .get(String(chatId), String(userId)) as { recent_ats: string } | null;
  return row ? (JSON.parse(row.recent_ats) as number[]) : [];
};

test("seven clean messages in a group end review there, and the next ad is left alone", async () => {
  await w.join(64, GROUP, KITAN);
  for (let i = 0; i < 7; i++) await w.say(64, GROUP, `hello ${i}`);
  expect(recentOf(64, GROUP)).toHaveLength(7);
  const recorded = w.events(64).length;
  w.calls = [];
  await w.say(64, GROUP, "cheap followers t.me/spam");
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
  expect(w.callsTo("restrictChatMember")).toHaveLength(0);
  expect(w.events(64)).toHaveLength(recorded); // past review: nothing is recorded
});

test("deleted spam does not count towards graduation", async () => {
  await w.join(65, GROUP, KITAN);
  for (let i = 0; i < 7; i++) await w.say(65, GROUP, "join t.me/+abc");
  expect(w.callsTo("deleteMessage")).toHaveLength(7);
  expect(recentOf(65, GROUP)).toEqual([]);
  await w.say(65, GROUP, "hello");
  expect(w.events(65, "message").at(-1)?.detail.recent).toBe(0);
});

test("the gate is per group: seven clean messages elsewhere do not shield a new group", async () => {
  await w.join(66, GROUP, KITAN);
  await w.join(66, OTHER, KITAN);
  for (let i = 0; i < 7; i++) await w.say(66, GROUP, `hello ${i}`);
  w.calls = [];
  await w.say(66, OTHER, "cheap followers t.me/spam");
  expect(w.callsTo("deleteMessage")).toHaveLength(1);
});

test("the window rolls: messages older than a week no longer end review", async () => {
  await w.join(67, GROUP, KITAN);
  for (let i = 0; i < 7; i++) await w.say(67, GROUP, `hello ${i}`);
  const old = Date.now() - 8 * DAY;
  w.db.run("UPDATE speakers SET recent_ats = ? WHERE chat_id = ? AND user_id = ?", [
    JSON.stringify(Array(7).fill(old)),
    String(GROUP),
    "67",
  ]);
  w.calls = [];
  await w.say(67, GROUP, "cheap followers t.me/spam");
  expect(w.callsTo("deleteMessage")).toHaveLength(1);
});

test("an ordinary web link or a plain forward is not a rule, though the message is recorded", async () => {
  await w.say(61, GROUP, "看看这个 https://www.youtube.com/watch?v=x");
  await w.say(61, GROUP, "https://exhentai.org/g/1/abc/");
  await w.say(61, GROUP, "", {
    caption: "好图",
    photo: [{ file_id: "p", width: 320, height: 320 }],
    forward_origin: { type: "user" },
  });
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
  expect(w.callsTo("restrictChatMember")).toHaveLength(0);
  expect(w.callsTo("banChatMember")).toHaveLength(0);
  expect(w.events(61, "message")).toHaveLength(3);
});

test("the hourly job prunes what retention allows", async () => {
  const old = Date.now() - 40 * DAY;
  w.db.run("INSERT INTO offenses (user_id, chat_id, reason, score, at) VALUES ('1', 'g', 'link', 1, ?)", [old]);
  w.db.run("INSERT INTO events (at, chat_id, user_id, kind, detail) VALUES (?, 'g', '1', 'message', '{}')", [old]);
  await w.hourly();
  expect(w.db.query("SELECT count(*) AS n FROM offenses").get()).toEqual({ n: 0 });
  expect(w.db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
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

test("link-button ads from a bot, a channel and a member are removed; an established member's never are", async () => {
  const buttons = { reply_markup: { inline_keyboard: [[{ text: "进群领福利", url: "https://t.me/+abc" }]] } };
  await w.say(31, GROUP, "福利群", buttons, { is_bot: true, username: "promo_bot" });
  await w.hook({
    message: { message_id: 900, chat: { id: GROUP, type: "supergroup" }, sender_chat: { id: -100555, title: "福利频道" }, from: { id: 136817688, is_bot: true }, text: "看这里", ...buttons },
  });
  await w.say(32, GROUP, "推荐", { ...buttons, via_bot: { username: "some_inline_bot" } });
  expect(w.callsTo("deleteMessage")).toHaveLength(3);
  expect(w.callsTo("banChatMember").map((c) => c.params.user_id)).toEqual([31]);
  expect(w.callsTo("banChatSenderChat").map((c) => c.params.sender_chat_id)).toEqual([-100555]);
  expect(w.events(32, "action")[0].detail.rule).toBe("inline_bot");

  // Once a member has seven clean messages here, a button no longer touches them.
  for (let i = 0; i < 7; i++) await w.say(63, GROUP, `hello ${i}`);
  const recorded = w.events(63).length;
  w.calls = [];
  await w.say(63, GROUP, "推荐", { ...buttons, via_bot: { username: "some_inline_bot" } });
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
  expect(w.events(63)).toHaveLength(recorded);
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

test("a human admin is never moderated, however new or spammy they look", async () => {
  // A group owner who joined today still gets no rules, no models, no mute and no footprint.
  w.admins = [{ id: 60 }];
  await w.join(60, GROUP, KITAN, { first_name: "群主" });
  const recorded = w.events(60).length;
  w.calls = [];
  await w.say(60, GROUP, "join t.me/+abc");
  await w.say(60, GROUP, "日赚五百", { forward_origin: { type: "channel" } });
  await w.say(60, GROUP, "@BSGJUU_bot");
  await w.say(60, GROUP, "/setu@kmuav2bot", { entities: [{ type: "bot_command", offset: 0, length: 15 }] });
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
  expect(w.callsTo("restrictChatMember")).toHaveLength(0);
  expect(w.callsTo("banChatMember")).toHaveLength(0);
  expect(w.events(60)).toHaveLength(recorded); // not even recorded
  expect(w.db.query("SELECT count(*) AS n FROM offenses WHERE user_id = '60'").get()).toEqual({ n: 0 });
});

test("a slash command naming a bot is not a bot promotion", async () => {
  await w.join(62, GROUP, KITAN);
  await w.say(62, GROUP, "/setu@kmuav2bot", { entities: [{ type: "bot_command", offset: 0, length: 15 }] });
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
  expect(w.events(62, "action")).toHaveLength(0);
});

test("within seven messages, high-confidence text or image model ad verdicts delete, mute and do not count towards graduation", async () => {
  w.bios.set(68, "做单点击公群 https://t.me/+abc");
  w.decision = () => 0.99;
  w.model = () => ({ ad: true, confidence: 0.95, kind: "diversion", reason: "bio invite + pitch" });
  await w.join(68, GROUP, KITAN);
  await w.say(68, GROUP, "长·期·招·丝·滑·码 私·信·我");
  expect(w.callsTo("deleteMessage")).toHaveLength(1);
  expect(w.callsTo("restrictChatMember")).toHaveLength(1);
  expect(w.events(68, "action")[0].detail).toMatchObject({ rule: "llm", action: "mute" });
  expect(recentOf(68, GROUP)).toEqual([]); // deleted LLM spam must not buy its way out

  // Photo ad with no text or bio: image model alone catches it when confident with visible ad text.
  w.model = () => ({ ad: true, confidence: 0.95, kind: "diversion", reason: "QR poster", transcript: "扫码进群领福利" });
  await w.join(69, GROUP, KITAN);
  await w.say(69, GROUP, "", { photo: [{ file_id: "ad_img", width: 320, height: 320 }] });
  expect(w.callsTo("deleteMessage")).toHaveLength(2);
  expect(w.events(69, "action")[0].detail).toMatchObject({ rule: "llm", action: "mute" });
});

test("an ordinary photo or anime image from a newcomer is not deleted by the image model", async () => {
  w.model = () => ({ ad: true, confidence: 0.8, kind: "diversion", reason: "uncertain game screenshot", transcript: "" });
  await w.join(70, GROUP, KITAN);
  await w.say(70, GROUP, "", { photo: [{ file_id: "art_img", width: 320, height: 320 }] });
  expect(w.callsTo("deleteMessage")).toHaveLength(0);
  expect(recentOf(70, GROUP)).toHaveLength(1);
});
