// The only module that reads or writes D1. Attempts are stored as flat rows and
// converted to typed states by the pure codec below; `save` writes a step only
// if the row still has the status the step started from, so two workers
// racing on one attempt cannot both apply.
import type { Attempt, DeclineReason, Delivery, NewAttempt } from "./attempt";
import type { Forest } from "./iforest";
import { type Trajectory, empty } from "./trajectory";

interface AttemptRow {
  id: number;
  chat_id: string;
  chat_title: string | null;
  user_id: string;
  delivery: "guard" | "dm";
  query_id: string | null;
  token: string | null;
  message_id: number | null;
  status: Attempt["status"];
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  error: string | null;
  misses: number;
}

// ---------- codec (pure) ----------

function decode(row: AttemptRow): Attempt {
  const delivery = decodeDelivery(row);
  const base = {
    id: row.id,
    chatId: row.chat_id,
    chatTitle: row.chat_title,
    userId: row.user_id,
    delivery,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    misses: row.misses,
  };
  const decidedAt = row.decided_at ?? row.created_at;
  switch (row.status) {
    case "pending":
      return { ...base, status: "pending" };
    case "approved":
    case "expired":
      return { ...base, status: row.status, decidedAt };
    case "failed":
    case "unreachable":
    case "queued":
      return { ...base, status: row.status, decidedAt, error: row.error ?? "" };
    case "declined":
      return { ...base, status: "declined", decidedAt, reason: row.error as DeclineReason };
  }
}

function decodeDelivery(row: AttemptRow): Delivery {
  if (row.delivery === "guard" && row.query_id) return { kind: "guard", queryId: row.query_id };
  if (row.delivery === "dm" && row.token) return { kind: "dm", token: row.token, messageId: row.message_id };
  throw new Error(`attempt ${row.id}: ${row.delivery} row without its key`);
}

function encode(a: NewAttempt) {
  return {
    status: a.status,
    expires_at: a.expiresAt,
    decided_at: a.status === "pending" ? null : a.decidedAt,
    error:
      a.status === "failed" || a.status === "unreachable" || a.status === "queued"
        ? a.error.slice(0, 300)
        : a.status === "declined"
          ? a.reason
          : null,
    message_id: a.delivery.kind === "dm" ? a.delivery.messageId : null,
  };
}

// ---------- attempts ----------

// Returns null when the request is already handled: a redelivered guard query,
// or a DM challenge still open for this user and chat.
export async function insertAttempt(
  db: D1Database,
  a: NewAttempt,
  lols: boolean | null,
  now: number,
): Promise<Attempt | null> {
  if (a.delivery.kind === "dm" && a.status === "pending") {
    const open = await db
      .prepare(
        `SELECT 1 FROM attempts
         WHERE chat_id = ? AND user_id = ? AND delivery = 'dm' AND status = 'pending' AND expires_at > ?`,
      )
      .bind(a.chatId, a.userId, now)
      .first();
    if (open) return null;
  }
  const e = encode(a);
  const row = await db
    .prepare(
      `INSERT OR IGNORE INTO attempts
         (chat_id, chat_title, user_id, delivery, query_id, token, status, created_at, expires_at, lols, error, decided_at, misses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      a.chatId,
      a.chatTitle,
      a.userId,
      a.delivery.kind,
      a.delivery.kind === "guard" ? a.delivery.queryId : null,
      a.delivery.kind === "dm" ? a.delivery.token : null,
      e.status,
      a.createdAt,
      a.expiresAt,
      lols === null ? null : Number(lols),
      e.error,
      e.decided_at,
      a.misses,
    )
    .first<AttemptRow>();
  return row ? decode(row) : null;
}

// Checks this person let lapse in this group since `since`.
export async function countMisses(db: D1Database, chatId: string, userId: string, since: number): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM attempts WHERE chat_id = ? AND user_id = ? AND status = 'expired' AND created_at > ?`)
    .bind(chatId, userId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Writes `next` if the row still has `from.status`; false when another worker moved it first.
export async function save(db: D1Database, from: Attempt, next: Attempt): Promise<boolean> {
  const e = encode(next);
  const row = await db
    .prepare(
      `UPDATE attempts SET status = ?, expires_at = ?, decided_at = ?, error = ?, message_id = ?
       WHERE id = ? AND status = ? RETURNING id`,
    )
    .bind(e.status, e.expires_at, e.decided_at, e.error, e.message_id, from.id, from.status)
    .first();
  return row !== null;
}

export async function findAttempt(db: D1Database, key: { queryId: string } | { token: string }): Promise<Attempt | null> {
  const row =
    "queryId" in key
      ? await db.prepare(`SELECT * FROM attempts WHERE query_id = ?`).bind(key.queryId).first<AttemptRow>()
      : await db.prepare(`SELECT * FROM attempts WHERE token = ?`).bind(key.token).first<AttemptRow>();
  return row ? decode(row) : null;
}

// This person's requests the bot could not DM about, still within their deadline.
export async function unreachableFor(db: D1Database, userId: string): Promise<Attempt[]> {
  const { results } = await db
    .prepare(`SELECT * FROM attempts WHERE user_id = ? AND status = 'unreachable' ORDER BY id`)
    .bind(userId)
    .all<AttemptRow>();
  return results.map(decode);
}

// Waiting attempts (see isWaiting in attempt.ts) past their deadline.
export async function waitingDue(db: D1Database, now: number): Promise<Attempt[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM attempts
       WHERE status IN ('pending', 'unreachable', 'queued') AND expires_at <= ? LIMIT 50`,
    )
    .bind(now)
    .all<AttemptRow>();
  return results.map(decode);
}

// ---------- measurement ----------

export async function markOpened(db: D1Database, id: number, now: number): Promise<void> {
  await db.prepare(`UPDATE attempts SET opened_at = COALESCE(opened_at, ?) WHERE id = ?`).bind(now, id).run();
}

export async function recordTry(db: D1Database, id: number, now: number, solveMs: number | null): Promise<void> {
  await db
    .prepare(
      `UPDATE attempts SET tries = tries + 1, opened_at = COALESCE(opened_at, ?), solve_ms = COALESCE(?, solve_ms)
       WHERE id = ?`,
    )
    .bind(now, solveMs, id)
    .run();
}

export async function recordTurnstileError(db: D1Database, id: number, error: string): Promise<void> {
  await db.prepare(`UPDATE attempts SET turnstile_error = ? WHERE id = ?`).bind(error, id).run();
}

// What an approved member did later: the outcome label for measurement.
export async function labelMember(
  db: D1Database,
  chatId: string,
  userId: string,
  outcome: "left" | "banned",
  now: number,
): Promise<void> {
  const column = outcome === "banned" ? "banned_at" : "left_at";
  await db
    .prepare(
      `UPDATE attempts SET ${column} = ?
       WHERE chat_id = ? AND user_id = ? AND status = 'approved' AND ${column} IS NULL`,
    )
    .bind(now, chatId, userId)
    .run();
}

export async function chatsSeen(db: D1Database): Promise<{ chat_id: string; chat_title: string | null }[]> {
  const { results } = await db
    .prepare(`SELECT chat_id, max(chat_title) AS chat_title FROM attempts GROUP BY chat_id ORDER BY chat_id LIMIT 50`)
    .all<{ chat_id: string; chat_title: string | null }>();
  return results;
}

// ---------- probation ----------

// Everything a group message needs about its sender, in one query: whether Kitan knows
// them in this group, when it saw them join, and their behaviour sketch.
export async function readStanding(
  db: D1Database,
  chatId: string,
  userId: string,
): Promise<{ known: boolean; joinedAt: number | null; trajectory: Trajectory }> {
  const row = await db
    .prepare(
      `SELECT (SELECT 1 FROM speakers WHERE chat_id = ?1 AND user_id = ?2) AS known,
              (SELECT joined_at FROM speakers WHERE chat_id = ?1 AND user_id = ?2) AS joined_at,
              (SELECT body FROM trajectories WHERE user_id = ?2) AS body`,
    )
    .bind(chatId, userId)
    .first<{ known: number | null; joined_at: number | null; body: string | null }>();
  return {
    known: Boolean(row?.known),
    joinedAt: row?.joined_at ?? null,
    trajectory: row?.body ? (JSON.parse(row.body) as Trajectory) : empty(),
  };
}

// Stores the updated sketch, and the first time someone speaks in a group, remembers them
// there. One round trip; a row is written only for the sketch and that first time.
export async function writeStanding(
  db: D1Database,
  chatId: string,
  userId: string,
  trajectory: Trajectory,
  firstInChat: boolean,
  now: number,
): Promise<void> {
  const sketch = db
    .prepare(
      `INSERT INTO trajectories (user_id, messages, updated_at, body) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at, body = excluded.body`,
    )
    .bind(userId, trajectory.messages, now, JSON.stringify(trajectory));
  const speaker = db.prepare(`INSERT OR IGNORE INTO speakers (chat_id, user_id) VALUES (?, ?)`).bind(chatId, userId);
  await db.batch(firstInChat ? [sketch, speaker] : [sketch]);
}

// A member joined, by any route. Rejoining makes them new again.
export async function recordJoin(db: D1Database, chatId: string, userId: string, trajectory: Trajectory, now: number) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO speakers (chat_id, user_id, joined_at) VALUES (?, ?, ?)
         ON CONFLICT (chat_id, user_id) DO UPDATE SET joined_at = excluded.joined_at`,
      )
      .bind(chatId, userId, now),
    db
      .prepare(
        `INSERT INTO trajectories (user_id, messages, updated_at, body) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET updated_at = excluded.updated_at, body = excluded.body`,
      )
      .bind(userId, trajectory.messages, now, JSON.stringify(trajectory)),
  ]);
}

export async function readTrajectory(db: D1Database, userId: string): Promise<Trajectory> {
  const row = await db.prepare(`SELECT body FROM trajectories WHERE user_id = ?`).bind(userId).first<{ body: string }>();
  return row ? (JSON.parse(row.body) as Trajectory) : empty();
}

// Cached per database, so separate deployments (and tests) never share values.
const countingSinceCache = new WeakMap<D1Database, number>();

export async function countingSince(db: D1Database): Promise<number> {
  let value = countingSinceCache.get(db);
  if (value === undefined) {
    value = (await db.prepare(`SELECT value FROM meta WHERE key = 'counting_since'`).first<{ value: number }>())?.value ?? 0;
    countingSinceCache.set(db, value);
  }
  return value;
}

// ---------- models ----------

const modelCache = new WeakMap<D1Database, { forest: Forest | null; until: number }>();

// The current isolation forest, re-read at most hourly per Worker instance.
export async function loadForest(db: D1Database, now: number): Promise<Forest | null> {
  const cached = modelCache.get(db);
  if (cached && cached.until > now) return cached.forest;
  const row = await db.prepare(`SELECT body FROM models WHERE name = 'trajectory_iforest'`).first<{ body: string }>();
  const forest = row ? (JSON.parse(row.body) as Forest) : null;
  modelCache.set(db, { forest, until: now + 60 * 60 * 1000 });
  return forest;
}

export async function modelAge(db: D1Database, now: number): Promise<number> {
  const row = await db.prepare(`SELECT trained_at FROM models WHERE name = 'trajectory_iforest'`).first<{ trained_at: number }>();
  return row ? now - row.trained_at : Infinity;
}

export async function saveForest(db: D1Database, forest: Forest, rows: number, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO models (name, trained_at, rows, body) VALUES ('trajectory_iforest', ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET trained_at = excluded.trained_at, rows = excluded.rows, body = excluded.body`,
    )
    .bind(now, rows, JSON.stringify(forest))
    .run();
}

// A random sample of active accounts' sketches: what ordinary behaviour looks like.
export async function trainingSketches(db: D1Database, minMessages: number, limit: number) {
  const { results } = await db
    .prepare(`SELECT user_id, body FROM trajectories WHERE messages > ? ORDER BY random() LIMIT ?`)
    .bind(minMessages, limit)
    .all<{ user_id: string; body: string }>();
  return results.map((r) => ({ userId: Number(r.user_id), trajectory: JSON.parse(r.body) as Trajectory }));
}

export async function chatsJoinedSince(db: D1Database, userId: string, since: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT chat_id FROM speakers WHERE user_id = ? AND joined_at > ?`)
    .bind(userId, since)
    .all<{ chat_id: string }>();
  return results.map((row) => row.chat_id);
}

// ---------- footprints ----------

// The profile recorded when this person last joined this chat.
export async function latestProfile(
  db: D1Database,
  chatId: string,
  userId: string,
): Promise<{ bio?: string; personal_chat?: string; approved_by?: string } | null> {
  const row = await db
    .prepare(`SELECT detail FROM events WHERE chat_id = ? AND user_id = ? AND kind = 'profile' ORDER BY at DESC LIMIT 1`)
    .bind(chatId, userId)
    .first<{ detail: string }>();
  return row ? JSON.parse(row.detail) : null;
}

export async function recordEvent(
  db: D1Database,
  event: { chatId: string; userId: string; kind: string; detail: Record<string, unknown> },
  now: number,
): Promise<void> {
  await db
    .prepare(`INSERT INTO events (at, chat_id, user_id, kind, detail) VALUES (?, ?, ?, ?, ?)`)
    .bind(now, event.chatId, event.userId, event.kind, JSON.stringify(event.detail))
    .run();
}

export async function countOffenses(db: D1Database, userId: string, since: number): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM offenses WHERE user_id = ? AND at > ?`)
    .bind(userId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertOffense(
  db: D1Database,
  userId: string,
  chatId: string,
  reason: string,
  now: number,
): Promise<void> {
  await db
    .prepare(`INSERT INTO offenses (user_id, chat_id, reason, at) VALUES (?, ?, ?, ?)`)
    .bind(userId, chatId, reason, now)
    .run();
}

// Records the hash and reports whether the same user sent it in another chat since `since`.
export async function seenElsewhere(
  db: D1Database,
  userId: string,
  chatId: string,
  hash: string,
  since: number,
  now: number,
): Promise<boolean> {
  const elsewhere = await db
    .prepare(`SELECT 1 FROM recent_messages WHERE user_id = ? AND hash = ? AND chat_id != ? AND at > ? LIMIT 1`)
    .bind(userId, hash, chatId, since)
    .first();
  await db
    .prepare(`INSERT INTO recent_messages (user_id, chat_id, hash, at) VALUES (?, ?, ?, ?)`)
    .bind(userId, chatId, hash, now)
    .run();
  return elsewhere !== null;
}

export async function prune(
  db: D1Database,
  before: { hashes: number; offenses: number; events: number },
): Promise<void> {
  await db.prepare(`DELETE FROM recent_messages WHERE at <= ?`).bind(before.hashes).run();
  await db.prepare(`DELETE FROM offenses WHERE at <= ?`).bind(before.offenses).run();
  await db.prepare(`DELETE FROM events WHERE at <= ?`).bind(before.events).run();
}
