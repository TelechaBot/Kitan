// Diversion targets: where an account is trying to send people. Spam samples are bios
// and messages from accounts removed on 2026-11-12; the ham are things people say.
import { describe, expect, test } from "bun:test";
import { diversionTargets } from "../src/probation";

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
