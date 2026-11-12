// Real incidents from a group's screenshots (2026-11-12), replayed against the real
// Worker. These pin down what the deterministic rules do and that the footprint
// records enough to reconstruct each case. Whether models catch them is measured
// by bench/, against the real models; the model here is a stand-in.
import { beforeEach, expect, test } from "bun:test";
import { World } from "./harness";

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
  expect(w.events(21, "message").map((e) => e.detail.index)).toEqual([1, 2, 3]);
});

test("passed Kitan's check, then a covert adult-services pitch", async () => {
  await w.join(22, GROUP, KITAN, { first_name: "mugabula", last_name: "twaha" });
  await w.say(22, GROUP, "新人一枚，不太会说话，只会哈哈哈");
  await w.say(22, GROUP, "现在全国夜场都要倒闭了 我们女生赚钱越来越难了");
  expect(w.callsTo("deleteMessage")).toHaveLength(0); // rules miss it: no link, button or mention
  expect(w.events(22, "join")[0].detail.approved_by).toBe("bot:@test_bot");
  const pitch = w.events(22, "verdict").find((v) => v.detail.index === 2);
  expect(pitch?.detail.text_model).toMatchObject({ model: "@cf/qwen/qwen3-30b-a3b-fp8" });
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

test("the profile is read at join: bio and who admitted them", async () => {
  w.bios.set(25, "日入过万 私我进群");
  await w.join(25, GROUP, KITAN, { first_name: "景初" });
  const profile = w.events(25, "profile")[0].detail;
  expect(profile).toMatchObject({ bio: "日入过万 私我进群", approved_by: "bot:@test_bot" });
  expect(w.events(25, "verdict")[0].detail.lexicon).toEqual(expect.arrayContaining(["私我进群"]));
});

test("link-button ads from a bot, a channel identity and an old member are removed", async () => {
  const buttons = { reply_markup: { inline_keyboard: [[{ text: "进群领福利", url: "https://t.me/+abc" }]] } };
  await w.say(31, GROUP, "福利群", buttons, { is_bot: true, username: "promo_bot" });
  await w.hook({
    message: { message_id: 900, chat: { id: GROUP, type: "supergroup" }, sender_chat: { id: -100555, title: "福利频道" }, from: { id: 136817688, is_bot: true }, text: "看这里", ...buttons },
  });
  await w.say(32, GROUP, "推荐", { ...buttons, via_bot: { username: "some_inline_bot" } });
  expect(w.callsTo("deleteMessage")).toHaveLength(3);
  expect(w.callsTo("banChatMember").map((c) => c.params.user_id)).toEqual([31]);
  expect(w.callsTo("banChatSenderChat").map((c) => c.params.sender_chat_id)).toEqual([-100555]);
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
