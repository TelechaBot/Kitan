// Diversion targets: where an account is trying to send people. Spam samples are bios
// and messages from accounts removed on 2026-11-12; the ham are things people say.
import { describe, expect, test } from "bun:test";
import { bannedWords } from "../src/lexicon";
import { type Judgement, diversionTargets, isBlocked, judge } from "../src/probation";

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
