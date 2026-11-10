import { describe, expect, it } from "bun:test";
import { Store } from "../src/db";

function store(): Store {
  return new Store(":memory:");
}

describe("updates", () => {
  it("claims an update once", () => {
    const db = store();
    expect(db.claimUpdate(1)).toBe(true);
    expect(db.claimUpdate(1)).toBe(false);
    db.releaseUpdate(1);
    expect(db.claimUpdate(1)).toBe(true);
    db.close();
  });
});

describe("pending verification", () => {
  it("replaces the previous token for the same user and chat", () => {
    const db = store();
    const now = Date.now();
    db.upsertPending({
      token: "a",
      chatId: "-100",
      userId: "42",
      now,
      expiresAt: now + 60_000,
    });
    db.upsertPending({
      token: "b",
      chatId: "-100",
      userId: "42",
      now,
      expiresAt: now + 60_000,
    });
    expect(db.getPending("a")).toBeNull();
    expect(db.getPending("b")?.user_id).toBe("42");
    db.close();
  });

  it("consumes a token once and takes expired tokens", () => {
    const db = store();
    const now = Date.now();
    db.upsertPending({
      token: "a",
      chatId: "-100",
      userId: "42",
      now,
      expiresAt: now + 60_000,
    });
    expect(db.consumePending("a")?.user_id).toBe("42");
    expect(db.consumePending("a")).toBeNull();
    db.upsertPending({
      token: "b",
      chatId: "-100",
      userId: "43",
      now,
      expiresAt: now - 1,
    });
    expect(db.takeExpiredPending(now).map((row) => row.token)).toEqual(["b"]);
    db.close();
  });
});

describe("members", () => {
  it("does not overwrite state on ensure", () => {
    const db = store();
    const now = Date.now();
    db.ensureMember("-100", "42", "probation", now);
    db.setMemberState("-100", "42", "trusted", now);
    db.ensureMember("-100", "42", "probation", now);
    expect(db.getMember("-100", "42")?.state).toBe("trusted");
    db.close();
  });

  it("counts messages and duplicates", () => {
    const db = store();
    const now = Date.now();
    db.recordMessage("-100", "42", "hash", 5, now);
    db.recordMessage("-100", "42", "hash", 5, now);
    const stats = db.recentStats("-100", "42", now);
    expect(stats.recent).toBe(2);
    expect(db.duplicateCount("-100", "42", "hash", now, 60_000)).toBe(2);
    db.close();
  });
});

describe("settings", () => {
  it("defaults anti-spam on and toggles it", () => {
    const db = store();
    expect(db.getSettings("-100")).toEqual({ antiSpam: true });
    expect(db.toggleAntiSpam("-100")).toBe(false);
    expect(db.getSettings("-100")).toEqual({ antiSpam: false });
    db.close();
  });
});

describe("users", () => {
  it("tracks cross-group offenses and blocks repeat offenders", () => {
    const db = store();
    const now = Date.now();
    db.touchUser("42", now);
    expect(db.getUser("42")?.offenses).toBe(0);
    db.addUserOffense("42", now);
    db.addUserOffense("42", now);
    expect(db.isGloballyBlocked("42", now)).toBe(false);
    db.addUserOffense("42", now);
    expect(db.isGloballyBlocked("42", now)).toBe(true);
    expect(db.isGloballyBlocked("42", now + 31 * 24 * 60 * 60 * 1000)).toBe(
      false,
    );
    db.close();
  });
});
