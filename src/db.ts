// The only module that reads or writes D1. Attempts are stored as flat rows and
// converted to typed states by the pure codec below; `save` writes a step only
// if the row still has the status the step started from, so two workers
// racing on one attempt cannot both apply.
import type { Attempt, DeclineReason, Delivery, NewAttempt } from "./attempt";

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
      a.status === "failed" || a.status === "unreachable"
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
         (chat_id, chat_title, user_id, delivery, query_id, token, status, created_at, expires_at, lols, error, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    )
    .first<AttemptRow>();
  return row ? decode(row) : null;
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

// Requests this person made recently that the bot could not DM about.
export async function unreachableFor(db: D1Database, userId: string, since: number): Promise<Attempt[]> {
  const { results } = await db
    .prepare(`SELECT * FROM attempts WHERE user_id = ? AND status = 'unreachable' AND created_at > ? ORDER BY id`)
    .bind(userId, since)
    .all<AttemptRow>();
  return results.map(decode);
}

export async function pendingDue(db: D1Database, now: number): Promise<Attempt[]> {
  const { results } = await db
    .prepare(`SELECT * FROM attempts WHERE status = 'pending' AND expires_at <= ? LIMIT 50`)
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

// Counts a message against the member's latest approval in this chat if it was
// approved after `since` and has sent fewer than `maxMessages`. Returns when it
// was approved, or null when the member is not on probation.
export async function countProbationMessage(
  db: D1Database,
  chatId: string,
  userId: string,
  since: number,
  maxMessages: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `UPDATE attempts SET messages = messages + 1
       WHERE id = (SELECT id FROM attempts
                   WHERE chat_id = ? AND user_id = ? AND status = 'approved' AND decided_at > ?
                     AND messages < ? AND banned_at IS NULL
                   ORDER BY decided_at DESC LIMIT 1)
       RETURNING decided_at`,
    )
    .bind(chatId, userId, since, maxMessages)
    .first<{ decided_at: number }>();
  return row?.decided_at ?? null;
}

export async function chatsApprovedSince(db: D1Database, userId: string, since: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT chat_id FROM attempts WHERE user_id = ? AND status = 'approved' AND decided_at > ?`)
    .bind(userId, since)
    .all<{ chat_id: string }>();
  return results.map((row) => row.chat_id);
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

export async function prune(db: D1Database, hashesBefore: number, offensesBefore: number): Promise<void> {
  await db.prepare(`DELETE FROM recent_messages WHERE at <= ?`).bind(hashesBefore).run();
  await db.prepare(`DELETE FROM offenses WHERE at <= ?`).bind(offensesBefore).run();
}
