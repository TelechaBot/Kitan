import { describe, expect, it } from "bun:test";
import { detectSignals, messageFeatures } from "../src/signals";
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

describe("messageFeatures", () => {
  it("extracts links, mentions, and a stable hash", () => {
    const first = messageFeatures({
      message_id: 1,
      text: "hello https://t.me/x @one @two @three @four",
    });
    expect(first.mentions).toBe(4);
    expect(first.length).toBeGreaterThan(0);
    expect(first.hash.length).toBeGreaterThan(0);
  });

  it("normalizes width and case for duplicate detection", () => {
    const wide = messageFeatures({ message_id: 1, text: "ＨＥＬＬＯ" });
    const plain = messageFeatures({ message_id: 2, text: "hello" });
    expect(wide.hash).toBe(plain.hash);
  });

  it("gives media-only messages a unique identity", () => {
    const first = messageFeatures({ message_id: 1, photo: [] });
    const second = messageFeatures({ message_id: 2, photo: [] });
    expect(first.mediaOnly).toBe(true);
    expect(first.hash).not.toBe(second.hash);
  });
});

describe("detectSignals", () => {
  it("returns nothing for a normal first message", () => {
    expect(detectSignals(base)).toEqual([]);
  });

  it("detects links, mentions, duplicates, and floods", () => {
    const names = detectSignals({
      ...base,
      text: "https://example.com @one @two @three @four",
      mentions: 4,
      duplicateCount: 2,
      recentCount: 5,
    }).map((signal) => signal.name);
    expect(names).toContain("link");
    expect(names).toContain("mention");
    expect(names).toContain("duplicate");
    expect(names).toContain("flood");
  });

  it("treats media-only as a weak probation signal", () => {
    expect(
      detectSignals({ ...base, mediaOnly: true }).map((s) => s.name),
    ).toEqual(["media_only"]);
    expect(
      detectSignals({
        ...base,
        state: "member",
        mediaOnly: true,
      }),
    ).toEqual([]);
  });
});

