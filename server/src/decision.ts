import { detectSignals } from "./signals";
import type { MemberState, SignalInput, Verdict } from "./types";

const THRESHOLDS: Record<
  Exclude<MemberState, "left" | "banned">,
  { remove: number; restrict: number; review: number }
> = {
  probation: { remove: 0.7, restrict: 0.45, review: 0.3 },
  member: { remove: 0.85, restrict: 0.65, review: 0.5 },
  trusted: { remove: 1.1, restrict: 1.1, review: 0.6 },
};

export function decideMessage(input: SignalInput): Verdict {
  if (input.state === "left" || input.state === "banned") {
    return { action: "allow", risk: 0, reasons: [] };
  }

  const reasons = detectSignals(input);
  const risk = Math.min(
    1,
    reasons.reduce((total, signal) => total + signal.weight, 0),
  );
  if (reasons.length === 0) {
    return { action: "allow", risk, reasons };
  }

  const limit = THRESHOLDS[input.state];

  if (risk >= limit.remove) {
    return { action: "remove", risk, reasons };
  }
  if (risk >= limit.restrict) {
    return { action: "restrict", risk, reasons };
  }
  if (risk >= limit.review) {
    return { action: "review", risk, reasons };
  }
  return { action: "allow", risk, reasons };
}
