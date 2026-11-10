import { describe, expect, it } from "bun:test";
import { decideMessage } from "../src/decision";
import type { SignalInput } from "../src/types";

const base: SignalInput = {
  text: "hello",
  state: "probation",
  recentCount: 1,
  shortCount: 0,
  duplicateCount: 1,
  mediaOnly: false,
  external: false,
  mentions: 0,
};

describe("decideMessage", () => {
  it("allows a clean message", () => {
    expect(decideMessage(base).action).toBe("allow");
  });

  it("restricts a link from a probation member", () => {
    expect(decideMessage({ ...base, text: "https://example.com" }).action).toBe(
      "restrict",
    );
  });

  it("removes a link plus external reply from a probation member", () => {
    expect(
      decideMessage({
        ...base,
        text: "https://example.com",
        external: true,
      }).action,
    ).toBe("remove");
  });

  it("removes a duplicate from a probation member", () => {
    expect(decideMessage({ ...base, duplicateCount: 2 }).action).toBe(
      "remove",
    );
  });

  it("reviews a link from a member", () => {
    expect(
      decideMessage({
        ...base,
        state: "member",
        text: "https://example.com",
      }).action,
    ).toBe("review");
  });

  it("removes a link plus external reply from a member", () => {
    expect(
      decideMessage({
        ...base,
        state: "member",
        text: "https://example.com",
        external: true,
      }).action,
    ).toBe("remove");
  });

  it("only reviews a trusted member", () => {
    expect(
      decideMessage({
        ...base,
        state: "trusted",
        text: "https://example.com",
        external: true,
      }).action,
    ).toBe("review");
  });

  it("ignores left and banned members", () => {
    expect(
      decideMessage({
        ...base,
        state: "left",
        text: "https://example.com",
      }).action,
    ).toBe("allow");
    expect(
      decideMessage({
        ...base,
        state: "banned",
        text: "https://example.com",
      }).action,
    ).toBe("allow");
  });
});
