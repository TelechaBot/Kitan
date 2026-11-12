import { expect, test } from "bun:test";
import { parseVerdict } from "../src/classify";

test("a reply cut off mid-transcript still yields its verdict", () => {
  const cut = '{"ad": true, "confidence": 0.95, "kind": "scam", "reason": "USDT exchange price list", "transcript": "第1档 1000U=7100元 秒到账 担保交易 量大可谈 第2档 1000U=71';
  expect(parseVerdict(cut)).toMatchObject({ ad: true, confidence: 0.95, kind: "scam", reason: "USDT exchange price list" });
});

test("prose and thinking around the JSON are ignored", () => {
  const raw = '<think>hmm</think>Here is my answer:\n{"ad": false, "confidence": 0.9, "kind": "none", "reason": "a greeting"}\nThanks.';
  expect(parseVerdict(raw)).toMatchObject({ ad: false, confidence: 0.9, kind: "none" });
});

test("a reply without a verdict is not mistaken for one", () => {
  expect(parseVerdict("I cannot help with that.")).toBeNull();
  expect(parseVerdict('{"confidence": 0.9}')).toBeNull();
});
