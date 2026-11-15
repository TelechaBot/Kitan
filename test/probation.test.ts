// Diversion targets: where an account is trying to send people. Spam samples are bios
// and messages from accounts removed on 2026-11-12; the ham are things people say.
import { describe, expect, test } from "bun:test";
import { bannedWords } from "../src/lexicon";
import {
  type Judgement,
  type Standing,
  diversionTargets,
  isBlocked,
  judge,
  needsReview,
  spamReason,
} from "../src/probation";
import type { Message } from "../src/types";

describe("penalties grow with the evidence", () => {
  const base = { reason: null, duplicateElsewhere: false, repeatedHere: false, priorOffenses: 0, pointsElsewhere: false, sociable: false, now: 0 };
  const verdict = (j: Partial<Judgement>) => {
    const v = judge({ ...base, ...j });
    return v.action === "mute" ? `mute ${v.until / 60_000} min` : v.action;
  };

  test("a newcomer's first link is three minutes, as in the Python bot", () => {
    expect(verdict({ reason: "link" })).toBe("mute 3 min");
  });

  test("a profile that points elsewhere weighs most; being talked with weighs less", () => {
    expect(verdict({ reason: "keyword" })).toBe("mute 60 min");
    expect(verdict({ reason: "keyword", pointsElsewhere: true })).toBe("mute 1440 min");
    expect(verdict({ repeatedHere: true })).toBe("mute 360 min");
    expect(verdict({ repeatedHere: true, pointsElsewhere: true })).toBe("burn");
    expect(verdict({ repeatedHere: true, pointsElsewhere: true, sociable: true })).toBe("mute 1440 min");
  });

  test("each earlier offense adds two, and a ban is what bars an account from joining", () => {
    expect([0, 1, 2].map((priorOffenses) => verdict({ reason: "link", priorOffenses }))).toEqual(["mute 3 min", "mute 360 min", "burn"]);
    expect(isBlocked(0)).toBe(false);
    expect(isBlocked(1)).toBe(true);
  });
});

describe("the keyword layer", () => {
  test("the Python bot's chat list, through zero-width padding", () => {
    // 2026-11-12, "章响哥" accounts, with a zero-width character between letters.
    expect(bannedWords("二道混 ‌招代​收代付啦")).toEqual(["代付"]);
  });

  test("an offer that is the whole message, and only then", () => {
    expect(bannedWords("可约")).toEqual(["可约"]);
    expect(bannedWords("可约吗？")).toEqual(["可约吗"]);
    expect(bannedWords("合同里可约定违约金吗")).toEqual([]);
  });

  test("words people also use in ordinary talk are not acted on", () => {
    for (const text of ["我是做社工的", "有没有担保交易的群", "新号怎么引流比较好", "附近有药房吗", "可以代发货吗"]) {
      expect(bannedWords(text)).toEqual([]);
    }
  });
});

const kinds = (where: Parameters<typeof diversionTargets>[0]) => diversionTargets(where).map((t) => `${t.kind}@${t.in}`);

describe("diversion targets", () => {
  test("invite links in a bio, counted once as an invite", () => {
    expect(kinds({ bio: "最新项目 小白可做 秒下款 公群：https://t.me/+ZigUlMOiIzxiY2E1" })).toEqual(["invite@bio", "pointer@bio"]);
  });

  test("handles, pointers to the profile, and a contact card", () => {
    expect(kinds({ message: "低折全品类数码走私  @yjhdhbot  @jtyfgbot" })).toEqual(["handle@message", "handle@message"]);
    expect(kinds({ name: "👀主页.赚.米", message: "没项目看我主页" })).toEqual(["pointer@message"]);
    expect(kinds({ contact: "出售精仿假钞🔞面交" })).toEqual(["contact@card"]);
    expect(kinds({ message: "招代收，日入8千，看我主业" })).toEqual(["pointer@message"]);
  });

  test("links written to slip past filters", () => {
    expect(kinds({ bio: "进群链接 t 。me/+abc123" })).toContain("invite@bio");
    expect(kinds({ message: "加v：abc_12345" })).toEqual(["wechat@message"]);
    expect(kinds({ message: "扣扣 12345678" })).toEqual(["qq@message"]);
  });

  test("ordinary talk has no target", () => {
    for (const message of ["刚进群，大家好", "群名说要先看频道，频道是什么？", "有没有新手教程", "SOL 最近怎么跌这么多", "我提了个 issue，作者有空能看看吗"]) {
      expect(kinds({ message })).toEqual([]);
    }
  });
});

const NOW = 40 * 24 * 60 * 60 * 1000;
const COUNTING_SINCE = 10 * 24 * 60 * 60 * 1000;

describe("who is reviewed", () => {
  test("a high forest score alone never reopens a regular or active member", () => {
    // The global model was poisoned by one non-social group; its score is telemetry now.
    const regular: Standing = { joinedAt: null, messages: 3, firstAt: COUNTING_SINCE + 1000, anomaly: 0.99 };
    expect(needsReview(regular, COUNTING_SINCE, NOW)).toEqual({ review: false, why: "regular" });
    const active: Standing = { joinedAt: COUNTING_SINCE, messages: 21, firstAt: NOW - 1000, anomaly: 0.99 };
    expect(needsReview(active, COUNTING_SINCE, NOW)).toEqual({ review: false, why: "active" });
  });

  test("their own behaviour shifting does reopen review", () => {
    const active: Standing = { joinedAt: COUNTING_SINCE, messages: 21, firstAt: NOW - 1000, anomaly: null, riskShift: true };
    expect(needsReview(active, COUNTING_SINCE, NOW)).toEqual({ review: true, why: "anomalous" });
    const regular: Standing = { joinedAt: null, messages: 3, firstAt: COUNTING_SINCE + 1000, anomaly: 0.99, riskShift: true };
    expect(needsReview(regular, COUNTING_SINCE, NOW)).toEqual({ review: true, why: "anomalous" });
  });

  test("a new joiner is always reviewed, a quiet account too", () => {
    const newcomer: Standing = { joinedAt: NOW - 86_400_000, messages: 100, firstAt: NOW - 86_400_000, anomaly: null };
    expect(needsReview(newcomer, COUNTING_SINCE, NOW)).toEqual({ review: true, why: "newcomer" });
    const quiet: Standing = { joinedAt: COUNTING_SINCE, messages: 3, firstAt: null, anomaly: null };
    expect(needsReview(quiet, COUNTING_SINCE, NOW)).toEqual({ review: true, why: "quiet" });
  });
});

describe("what the rules treat as spam", () => {
  const msg = (text: string, extra: Partial<Message> = {}): Message =>
    Object.assign({ message_id: 1, chat: { id: 1 } }, text ? { text } : {}, extra) as Message;

  test("shared music, art, code and archives are not links", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.pixiv.net/artworks/123",
      "https://github.com/owner/repo",
      "https://exhentai.org/g/123/abc/",
      "https://e-hentai.org/g/123/abc/",
      "https://b23.tv/abc",
    ]) {
      expect(spamReason(msg(`看看这个 ${url}`))).toBeNull();
    }
  });

  test("a plain forwarded photo or user message is not an ad", () => {
    const photo: Message = {
      message_id: 2,
      chat: { id: 1 },
      caption: "好图",
      photo: [{ file_id: "p", width: 320, height: 320 }],
      forward_origin: { type: "user" },
    };
    expect(spamReason(photo)).toBeNull();
  });

  test("a slash command that names a bot is not a bot promo", () => {
    expect(spamReason(msg("/setu@kmuav2bot"))).toBeNull();
    expect(spamReason(msg("/setu@kmuav2bot", { entities: [{ type: "bot_command", offset: 0, length: 15 }] }))).toBeNull();
  });

  test("Telegram links, unknown hosts and look-alike domains still count", () => {
    expect(spamReason(msg("join t.me/+abc"))).toBe("link");
    expect(spamReason(msg("https://x.example/offer"))).toBe("link");
    expect(spamReason(msg("https://youtube.com.evil.example/x"))).toBe("link");
  });

  test("benign media with ad words is still caught, and so is a bot handle or a channel forward", () => {
    expect(spamReason(msg("日入过万 https://www.youtube.com/watch?v=x"))).toBe("link");
    expect(spamReason(msg("@BSGJUU_bot"))).toBe("bot_promo");
    expect(spamReason(msg("free money", { forward_origin: { type: "channel" } }))).toBe("forward");
  });

  test("scheme-less url entities to public media are not links", () => {
    expect(spamReason(msg("看看这个", { entities: [{ type: "text_link", offset: 0, length: 4, url: "youtu.be/abc" }] }))).toBeNull();
    expect(
      spamReason(msg("shorts", { entities: [{ type: "text_link", offset: 0, length: 6, url: "youtube.com/shorts/123" }] })),
    ).toBeNull();
    // The chat platforms are still links however they are written.
    expect(spamReason(msg("join", { entities: [{ type: "text_link", offset: 0, length: 4, url: "t.me/+abc" }] }))).toBe("link");
  });

  test("forwarding a person's public video is not an ad", () => {
    expect(spamReason(msg("https://www.youtube.com/watch?v=x", { forward_origin: { type: "user" } }))).toBeNull();
    expect(spamReason(msg("加v：abc_12345", { forward_origin: { type: "user" } }))).toBe("forward");
  });
});
