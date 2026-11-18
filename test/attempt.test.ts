// The join-attempt state machine as scenarios: each is a list of events fed to
// the pure step function, with the status and effects after every event.
import { describe, expect, test } from "bun:test";
import {
  type Attempt,
  DM_TTL_MS,
  SCREEN_TTL_MS,
  type Screening,
  GUARD_TTL_MS,
  type Intake,
  type JoinEvent,
  WAIT_TTL_MS,
  createStrictChallenge,
  intake,
  newMathQuestion,
  publicStep,
  step,
} from "../src/attempt";

const T0 = 1_000_000;

// A new join request, before its profile audit.
function arrive(overrides: Partial<Intake> = {}) {
  const first = intake({
    chatId: "-100",
    chatTitle: "G",
    userId: "42",
    delivery: { kind: "dm", token: "tok", messageId: null },
    blocked: false,
    lols: false,
    misses: 0,
    at: T0,
    ...overrides,
  });
  return { attempt: { ...first.attempt, id: 1 } as Attempt, effects: first.effects };
}

function screened(a: Attempt, verdict: Screening, repeat = false, at = T0) {
  return step(a, { type: "screened", verdict, repeat, strict: createStrictChallenge(), at });
}

// A request whose audit came back with `verdict` at T0; declined requests stay as they arrived.
function admit(overrides: Partial<Intake> = {}, verdict: Screening = "clean") {
  const first = arrive(overrides);
  if (first.attempt.status !== "screening") return first;
  const result = screened(first.attempt, verdict);
  if (!result.ok) throw new Error("screening refused");
  return { attempt: result.next, effects: result.effects };
}

// Runs events in order; a refused event leaves the state unchanged, as the store would.
function play(start: Attempt, events: JoinEvent[]): string[] {
  let state = start;
  return events.map((event) => {
    const result = step(state, event);
    if (!result.ok) return `${event.type}: refused (${result.reason})`;
    state = result.next;
    const effects = result.effects.map((e) => (e.type === "answer" ? e.result : e.type));
    return `${event.type}: ${state.status}${effects.length ? ` -> ${effects.join(",")}` : ""}`;
  });
}

describe("intake", () => {
  test("a new requester is screened first, with nothing sent yet", () => {
    expect(arrive().attempt).toMatchObject({ status: "screening", challenge: null, expiresAt: T0 + SCREEN_TTL_MS });
    expect(arrive().effects).toEqual([]);
  });

  test("a clean requester is then sent the ordinary check, with the path's time limit", () => {
    expect(admit().attempt.status).toBe("pending");
    expect(admit().effects).toEqual([{ type: "challenge" }]);
    expect(admit().attempt.expiresAt).toBe(T0 + DM_TTL_MS);
    expect(admit({ delivery: { kind: "guard", queryId: "Q" } }).attempt.expiresAt).toBe(T0 + GUARD_TTL_MS);
  });

  test("blocked or lols-listed accounts are declined without a challenge; Kitan's own record wins", () => {
    expect(admit({ lols: true }).attempt).toMatchObject({ status: "declined", reason: "lols_banned" });
    expect(admit({ blocked: true, lols: true }).attempt).toMatchObject({ status: "declined", reason: "kitan_blocklist" });
    expect(arrive({ blocked: true }).effects).toEqual([{ type: "answer", result: "decline" }]);
  });

  test("an unreachable lols does not decline anyone", () => {
    expect(admit({ lols: null }).attempt.status).toBe("pending");
  });
});

describe("strict challenges", () => {
  const ORDERS = ["cf,cf,math", "cf,math,cf", "math,cf,cf"];

  test("every strict check is two Turnstile steps and one sum, in one of three orders", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = createStrictChallenge();
      expect(c.index).toBe(0);
      expect(c.steps).toHaveLength(3);
      expect(c.steps.filter((s) => s === "cf")).toHaveLength(2);
      expect(c.steps.filter((s) => s === "math")).toHaveLength(1);
      seen.add(c.steps.join(","));
    }
    expect([...seen].sort()).toEqual(ORDERS);
  });

  test("the arithmetic question is a real sum or difference with the answer kept", () => {
    for (let i = 0; i < 100; i++) {
      const q = newMathQuestion();
      const match = /^(\d+) ([+-]) (\d+)$/.exec(q.question);
      expect(match).not.toBeNull();
      const [, left, sign, right] = match!;
      const a = Number(left);
      const b = Number(right);
      expect(a).toBeGreaterThanOrEqual(10);
      expect(a).toBeLessThanOrEqual(49);
      expect(b).toBeGreaterThanOrEqual(10);
      expect(b).toBeLessThanOrEqual(49);
      if (sign === "-") expect(a).toBeGreaterThanOrEqual(b);
      expect(q.answer).toBe(sign === "-" ? a - b : a + b);
    }
  });

  test("the public step names only the current step and never the answer", () => {
    const c = createStrictChallenge();
    const first = publicStep(c);
    expect(first).toMatchObject({ index: 0, total: 3 });
    expect(["cf", "math"]).toContain(first.kind);
    expect(JSON.stringify(first)).not.toContain("answer");
    expect(JSON.stringify(first)).not.toContain("steps");

    c.index = 2;
    const last = publicStep(c);
    expect(last).toMatchObject({ index: 2, total: 3 });
    if (last.kind === "math") expect(last.question).toBe(c.math.question);
    else expect(last.question).toBeUndefined();
    expect(JSON.stringify(last)).not.toContain("answer");
  });

});

describe("screening", () => {
  const { attempt } = arrive();

  test("an ad profile asking for the first time is told why and declined, in that order", () => {
    const result = screened(attempt, "ad");
    expect(result.ok && result.next).toMatchObject({ status: "declined", reason: "ad_profile" });
    expect(result.ok && result.effects).toEqual([{ type: "notify_ad" }, { type: "answer", result: "decline" }]);
  });

  test("an ad profile asking again gets the strict check, not another decline", () => {
    const result = screened(attempt, "ad", true);
    expect(result.ok && result.next.status).toBe("pending");
    expect(result.ok && result.next.challenge?.steps).toHaveLength(3);
    expect(result.ok && result.effects).toEqual([{ type: "challenge" }]);
  });

  test("an audit that could not finish gets the strict check: unread is not clean", () => {
    const result = screened(attempt, "suspect");
    expect(result.ok && result.next.challenge?.steps).toHaveLength(3);
  });

  test("a clean profile gets the ordinary check, even after an earlier ad decline", () => {
    const result = screened(attempt, "clean", true);
    expect(result.ok && result.next.challenge).toBeNull();
  });

  test("the check's time limit starts when screening ends, not when the request came in", () => {
    const result = screened(attempt, "clean", false, T0 + 20_000);
    expect(result.ok && result.next.expiresAt).toBe(T0 + 20_000 + DM_TTL_MS);
  });

  test("nobody can verify while screening, and an audit lost with its Worker is declined so they can ask again", () => {
    expect(
      play(attempt, [
        { type: "verified", at: T0 + 1 },
        { type: "tick", at: T0 + SCREEN_TTL_MS - 1 },
        { type: "tick", at: T0 + SCREEN_TTL_MS },
      ]),
    ).toEqual(["verified: refused (closed)", "tick: refused (not_due)", "tick: expired -> decline"]);
  });

  test("a late audit result after the sweep changes nothing", () => {
    const swept = step(attempt, { type: "tick", at: T0 + SCREEN_TTL_MS });
    expect(swept.ok && screened(swept.next, "ad").ok).toBe(false);
  });
});

describe("backoff for people who let a check lapse", () => {
  const MIN = 60 * 1000;

  test("each lapse triples the time for the next check, up to the cap", () => {
    const limits = [0, 1, 2, 3, 4, 5].map((misses) => (admit({ misses }).attempt.expiresAt - T0) / MIN);
    expect(limits).toEqual([5, 15, 45, 135, 360, 360]);
    const guard = [0, 1, 2].map(
      (misses) => (admit({ misses, delivery: { kind: "guard", queryId: "Q" } }).attempt.expiresAt - T0) / MIN,
    );
    expect(guard).toEqual([10, 30, 90]);
  });

  test("a returning person whose DM is refused waits longer for Start, but never past a day", () => {
    const waits = [0, 1, 2, 5].map((misses) => {
      const result = step(admit({ misses }).attempt, { type: "challenge_failed", error: "Forbidden", refused: true, at: T0 });
      return result.ok ? (result.next.expiresAt - T0) / MIN : null;
    });
    expect(waits).toEqual([60, 180, 540, 1440]);
  });

  test("pressing Start keeps the returning person's longer limit", () => {
    const { attempt } = admit({ misses: 1 });
    const unreachable = step(attempt, { type: "challenge_failed", error: "Forbidden", refused: true, at: T0 });
    const resumed = unreachable.ok ? step(unreachable.next, { type: "resumed", at: T0 + MIN }) : unreachable;
    expect(resumed.ok && resumed.next.expiresAt - (T0 + MIN)).toBe(15 * MIN);
  });
});

describe("journeys", () => {
  const { attempt } = admit();

  test("a person passes the check", () => {
    expect(play(attempt, [{ type: "challenged", messageId: 7 }, { type: "verified", at: T0 + 20_000 }])).toEqual([
      "challenged: pending",
      "verified: approved -> approve",
    ]);
  });

  test("a person who never opens the check is declined at the deadline, not before", () => {
    expect(
      play(attempt, [
        { type: "tick", at: T0 + DM_TTL_MS - 1 },
        { type: "tick", at: T0 + DM_TTL_MS },
        { type: "verified", at: T0 + DM_TTL_MS + 1 },
      ]),
    ).toEqual(["tick: refused (not_due)", "tick: expired -> decline", "verified: refused (closed)"]);
  });

  test("a submission after the deadline but before the expiry sweep is refused", () => {
    expect(play(attempt, [{ type: "verified", at: T0 + DM_TTL_MS + 1 }])).toEqual(["verified: refused (closed)"]);
  });

  test("Telegram refuses the DM: starting the bot within the hour reopens it with a fresh limit", () => {
    const later = T0 + WAIT_TTL_MS - 1;
    expect(
      play(attempt, [
        { type: "challenge_failed", error: "Forbidden", refused: true, at: T0 },
        { type: "verified", at: T0 + 1 },
        { type: "tick", at: T0 + DM_TTL_MS },
        { type: "resumed", at: later },
        { type: "verified", at: later + DM_TTL_MS - 1 },
      ]),
    ).toEqual([
      "challenge_failed: unreachable",
      "verified: refused (closed)",
      "tick: refused (not_due)",
      "resumed: pending",
      "verified: approved -> approve",
    ]);
  });

  test("an unreachable request nobody resumes is declined after the hour, so the person can ask again", () => {
    expect(
      play(attempt, [
        { type: "challenge_failed", error: "Forbidden", refused: true, at: T0 },
        { type: "tick", at: T0 + WAIT_TTL_MS },
        { type: "resumed", at: T0 + WAIT_TTL_MS + 1 },
      ]),
    ).toEqual(["challenge_failed: unreachable", "tick: expired -> decline", "resumed: refused (closed)"]);
  });

  test("any other failure to send the check goes to the admins, then is declined if they do nothing", () => {
    expect(
      play(attempt, [
        { type: "challenge_failed", error: "Bad Request", refused: false, at: T0 },
        { type: "resumed", at: T0 + 1 },
        { type: "tick", at: T0 + WAIT_TTL_MS },
      ]),
    ).toEqual(["challenge_failed: queued -> queue", "resumed: refused (not_due)", "tick: expired -> decline"]);
  });

  test("a queued guard-bot request is declined directly, since its query is spent", () => {
    const guard = admit({ delivery: { kind: "guard", queryId: "Q" } }).attempt;
    const queued = step(guard, { type: "challenge_failed", error: "Forbidden", refused: true, at: T0 });
    expect(queued.ok && queued.next.status).toBe("queued");
    const expired = queued.ok ? step(queued.next, { type: "tick", at: T0 + WAIT_TTL_MS }) : queued;
    expect(expired.ok && expired.effects).toEqual([{ type: "answer", result: "decline", queryUsed: true }]);
  });

  test("two submissions race: the second sees the first's approval", () => {
    expect(play(attempt, [{ type: "verified", at: T0 + 1 }, { type: "verified", at: T0 + 2 }])).toEqual([
      "verified: approved -> approve",
      "verified: refused (already_verified)",
    ]);
  });

  test("Telegram fails transiently while approving: the user retries and passes", () => {
    expect(
      play(attempt, [
        { type: "verified", at: T0 + 1 },
        { type: "approve_failed", gone: false, error: "502", at: T0 + 1 },
        { type: "verified", at: T0 + 2 },
      ]),
    ).toEqual(["verified: approved -> approve", "approve_failed: pending", "verified: approved -> approve"]);
  });

  test("the request was withdrawn before approval: the attempt fails for good", () => {
    expect(
      play(attempt, [
        { type: "verified", at: T0 + 1 },
        { type: "approve_failed", gone: true, error: "HIDE_REQUESTER_MISSING", at: T0 + 1 },
        { type: "verified", at: T0 + 2 },
      ]),
    ).toEqual(["verified: approved -> approve", "approve_failed: failed", "verified: refused (closed)"]);
  });

  test("an approved member is never expired by a late sweep", () => {
    expect(play(attempt, [{ type: "verified", at: T0 + 1 }, { type: "tick", at: T0 + DM_TTL_MS }])).toEqual([
      "verified: approved -> approve",
      "tick: refused (already_verified)",
    ]);
  });

  test("a declined account cannot verify its way in", () => {
    expect(play(admit({ lols: true }).attempt, [{ type: "verified", at: T0 + 1 }])).toEqual([
      "verified: refused (closed)",
    ]);
  });
});
