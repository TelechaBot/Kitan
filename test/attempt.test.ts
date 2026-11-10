// The join-attempt state machine as scenarios: each is a list of events fed to
// the pure step function, with the status and effects after every event.
import { describe, expect, test } from "bun:test";
import { type Attempt, DM_TTL_MS, GUARD_TTL_MS, type Intake, type JoinEvent, intake, step } from "../src/attempt";

const T0 = 1_000_000;

function admit(overrides: Partial<Intake> = {}) {
  const first = intake({
    chatId: "-100",
    chatTitle: "G",
    userId: "42",
    delivery: { kind: "dm", token: "tok", messageId: null },
    blocked: false,
    lols: false,
    at: T0,
    ...overrides,
  });
  return { attempt: { ...first.attempt, id: 1 } as Attempt, effects: first.effects };
}

// Runs events in order; a refused event leaves the state unchanged, as the store would.
function play(start: Attempt, events: JoinEvent[]): string[] {
  let state = start;
  return events.map((event) => {
    const result = step(state, event);
    if (!result.ok) return `${event.type}: refused (${result.reason})`;
    state = result.next;
    const effects = result.effects.map((e) => e.result);
    return `${event.type}: ${state.status}${effects.length ? ` -> ${effects.join(",")}` : ""}`;
  });
}

describe("intake", () => {
  test("a clean requester is pending a challenge, with the path's time limit", () => {
    expect(admit().attempt.status).toBe("pending");
    expect(admit().effects).toEqual([]);
    expect(admit().attempt.expiresAt).toBe(T0 + DM_TTL_MS);
    expect(admit({ delivery: { kind: "guard", queryId: "Q" } }).attempt.expiresAt).toBe(T0 + GUARD_TTL_MS);
  });

  test("blocked or lols-listed accounts are declined without a challenge; Kitan's own record wins", () => {
    expect(admit({ lols: true }).attempt).toMatchObject({ status: "declined", reason: "lols_banned" });
    expect(admit({ blocked: true, lols: true }).attempt).toMatchObject({ status: "declined", reason: "kitan_blocklist" });
    expect(admit({ blocked: true }).effects).toEqual([{ type: "answer", result: "decline" }]);
  });

  test("an unreachable lols does not decline anyone", () => {
    expect(admit({ lols: null }).attempt.status).toBe("pending");
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

  test("Telegram refuses the DM: the request goes to the admins and nothing can reopen it", () => {
    expect(
      play(attempt, [
        { type: "challenge_failed", error: "Forbidden", at: T0 },
        { type: "verified", at: T0 + 1 },
        { type: "tick", at: T0 + DM_TTL_MS },
      ]),
    ).toEqual(["challenge_failed: failed -> queue", "verified: refused (closed)", "tick: refused (closed)"]);
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
