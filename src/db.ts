// The only module that reads or writes D1. Attempts are stored as flat rows and
// converted to typed states by the pure codec below; `save` writes a step only
// if the row still has the status the step started from, so two workers
// racing on one attempt cannot both apply.
import type { Attempt, DeclineReason, Delivery, NewAttempt } from "./attempt";
import type { Forest } from "./iforest";
import { type Trajectory, empty, step } from "./trajectory";

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
    .prepare(`SELECT chat_id, title AS chat_title FROM chats ORDER BY chat_id LIMIT 100`)
    .all<{ chat_id: string; chat_title: string | null }>();
  return results;
}

// ---------- chats ----------

export interface ChatInfo {
  title: string | null;
  username: string | null;
  type: string | null;
}

// Last written per chat in this Worker instance, so most updates cost no write.
const chatCache = new WeakMap<D1Database, Map<string, { key: string; until: number }>>();

// Remembers a group's title and handle; written when they change, or hourly to mark it seen.
export async function noteChat(db: D1Database, chatId: string, info: ChatInfo, now: number): Promise<void> {
  const cache = chatCache.get(db) ?? new Map();
  chatCache.set(db, cache);
  const key = JSON.stringify(info);
  const cached = cache.get(chatId);
  if (cached && cached.key === key && cached.until > now) return;
  cache.set(chatId, { key, until: now + 60 * 60 * 1000 });
  await db
    .prepare(
      `INSERT INTO chats (chat_id, title, username, type, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (chat_id) DO UPDATE SET title = coalesce(excluded.title, title),
         username = coalesce(excluded.username, username), type = coalesce(excluded.type, type), last_seen = excluded.last_seen`,
    )
    .bind(chatId, info.title, info.username, info.type, now)
    .run();
}

export async function chatTitle(db: D1Database, chatId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT title FROM chats WHERE chat_id = ?`).bind(chatId).first<{ title: string | null }>();
  return row?.title ?? null;
}

// ---------- profiles ----------

export interface Profile {
  name: string | null;
  username: string | null;
  bio: string | null;
  personal_chat: string | null;
  has_photo: boolean | null;
  premium: boolean | null;
  lang: string | null;
  checked_at: number;
}

export async function readProfile(db: D1Database, userId: string): Promise<Profile | null> {
  const row = await db.prepare(`SELECT * FROM profiles WHERE user_id = ?`).bind(userId).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    name: row.name as string | null,
    username: row.username as string | null,
    bio: row.bio as string | null,
    personal_chat: row.personal_chat as string | null,
    has_photo: row.has_photo === null ? null : Boolean(row.has_photo),
    premium: row.premium === null ? null : Boolean(row.premium),
    lang: row.lang as string | null,
    checked_at: row.checked_at as number,
  };
}

export async function writeProfile(db: D1Database, userId: string, p: Profile): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO profiles (user_id, name, username, bio, personal_chat, has_photo, premium, lang, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      userId,
      p.name,
      p.username,
      p.bio,
      p.personal_chat,
      p.has_photo === null ? null : Number(p.has_photo),
      p.premium === null ? null : Number(p.premium),
      p.lang,
      p.checked_at,
    )
    .run();
}

// ---------- probation ----------

// Everything a group message needs about its sender, in one query: whether Kitan knows
// them in this group, when it saw them join, and their behaviour sketch.
export async function readStanding(
  db: D1Database,
  chatId: string,
  userId: string,
): Promise<{ known: boolean; joinedAt: number | null; groups: number; trajectory: Trajectory }> {
  const row = await db
    .prepare(
      `SELECT (SELECT 1 FROM speakers WHERE chat_id = ?1 AND user_id = ?2) AS known,
              (SELECT joined_at FROM speakers WHERE chat_id = ?1 AND user_id = ?2) AS joined_at,
              (SELECT count(*) FROM speakers WHERE user_id = ?2) AS groups,
              (SELECT body FROM trajectories WHERE user_id = ?2) AS body`,
    )
    .bind(chatId, userId)
    .first<{ known: number | null; joined_at: number | null; groups: number; body: string | null }>();
  return {
    known: Boolean(row?.known),
    joinedAt: row?.joined_at ?? null,
    // Kitan groups they joined or spoke in, counting this one even before the first write.
    groups: Math.max(1, (row?.groups ?? 0) + (row?.known ? 0 : 1)),
    trajectory: sketchCache(db).get(userId)?.t ?? (row?.body ? (JSON.parse(row.body) as Trajectory) : empty()),
  };
}

// Sketches of people who are not under review are written at most every SKETCH_WRITE_MS
// per Worker instance, and served from memory in between. D1's free tier writes 100,000
// rows a day, and one busy group sent ~1,700 messages an hour. A recycled instance loses
// at most that much of someone's sketch, which only blurs it.
const SKETCH_WRITE_MS = 15 * 60 * 1000;
const SKETCHES_KEPT = 5000;
const sketches = new WeakMap<D1Database, Map<string, { t: Trajectory; written: number }>>();

function sketchCache(db: D1Database) {
  let cache = sketches.get(db);
  if (!cache) sketches.set(db, (cache = new Map()));
  return cache;
}

// Remembers the sketch and says whether it is due to be written now.
function keepSketch(db: D1Database, userId: string, t: Trajectory, now: number, urgent: boolean): boolean {
  const cache = sketchCache(db);
  const entry = cache.get(userId);
  // First seen by this instance: the stored copy is as fresh as it gets.
  const due = urgent || (entry !== undefined && now - entry.written >= SKETCH_WRITE_MS);
  cache.delete(userId); // re-inserted last, so the oldest entry is first to go
  cache.set(userId, { t, written: due ? now : (entry?.written ?? now) });
  if (cache.size > SKETCHES_KEPT) cache.delete(cache.keys().next().value!);
  return due;
}

function sketchWrite(db: D1Database, userId: string, t: Trajectory, now: number) {
  return db
    .prepare(
      `INSERT INTO trajectories (user_id, messages, updated_at, body) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at, body = excluded.body`,
    )
    .bind(userId, t.messages, now, JSON.stringify(t));
}

// Stores the updated sketch (at once when `urgent`, otherwise see SKETCH_WRITE_MS), and the
// first time someone speaks in a group, remembers them there.
export async function writeStanding(
  db: D1Database,
  chatId: string,
  userId: string,
  trajectory: Trajectory,
  firstInChat: boolean,
  now: number,
  urgent: boolean,
): Promise<void> {
  const writes = [];
  if (keepSketch(db, userId, trajectory, now, urgent)) writes.push(sketchWrite(db, userId, trajectory, now));
  if (firstInChat) writes.push(db.prepare(`INSERT OR IGNORE INTO speakers (chat_id, user_id) VALUES (?, ?)`).bind(chatId, userId));
  if (writes.length) await db.batch(writes);
}

// Someone answered one of their messages: a sign of a member, not a billboard.
export async function creditReply(db: D1Database, userId: string, now: number): Promise<void> {
  const t = step(await readTrajectory(db, userId), { kind: "replied", at: now });
  if (keepSketch(db, userId, t, now, false)) await sketchWrite(db, userId, t, now).run();
}

// A member joined, by any route. Rejoining makes them new again.
export async function recordJoin(db: D1Database, chatId: string, userId: string, trajectory: Trajectory, now: number) {
  keepSketch(db, userId, trajectory, now, true);
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
  const cached = sketchCache(db).get(userId);
  if (cached) return cached.t;
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

// ---------- model budget ----------

const HOUR_MS = 60 * 60 * 1000;

export async function recordSpend(db: D1Database, neurons: number, now: number): Promise<void> {
  if (neurons <= 0) return;
  await db
    .prepare(`INSERT INTO spend (hour, neurons) VALUES (?, ?) ON CONFLICT (hour) DO UPDATE SET neurons = neurons + excluded.neurons`)
    .bind(Math.floor(now / HOUR_MS), neurons)
    .run();
}

// Neurons spent in the last 24 hours. Cloudflare's allowance behaved as a rolling day:
// calls failed at 06:00 UTC after 10,236 neurons in the 24 hours before.
export async function spentToday(db: D1Database, now: number): Promise<number> {
  const row = await db
    .prepare(`SELECT coalesce(sum(neurons), 0) AS n FROM spend WHERE hour > ?`)
    .bind(Math.floor(now / HOUR_MS) - 24)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// How many times the models have judged this account lately (skipped verdicts excluded).
export async function judgedSince(db: D1Database, userId: string, since: number): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM events WHERE user_id = ? AND kind = 'verdict' AND at > ? AND json_extract(detail, '$.skipped') IS NULL`)
    .bind(userId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
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

// How this person last joined this chat, while the footprint lasts.
export async function latestJoin(
  db: D1Database,
  chatId: string,
  userId: string,
): Promise<{ approved_by?: string; by_kitan?: boolean; invite_link?: string; invite_link_creator?: string } | null> {
  const row = await db
    .prepare(`SELECT detail FROM events WHERE chat_id = ? AND user_id = ? AND kind = 'join' ORDER BY at DESC LIMIT 1`)
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
  score: number,
  now: number,
): Promise<void> {
  await db
    .prepare(`INSERT INTO offenses (user_id, chat_id, reason, score, at) VALUES (?, ?, ?, ?, ?)`)
    .bind(userId, chatId, reason, score, now)
    .run();
}

// Offenses serious enough to have banned the account (probation.ts BAN_AT).
export async function countBans(db: D1Database, userId: string, since: number, banAt: number): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM offenses WHERE user_id = ? AND at > ? AND score >= ?`)
    .bind(userId, since, banAt)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Records the hash and counts this user's earlier copies of it since `since`, here and elsewhere.
export async function earlierCopies(
  db: D1Database,
  userId: string,
  chatId: string,
  hash: string,
  since: number,
  now: number,
): Promise<{ here: number; elsewhere: number }> {
  const [copies] = await db.batch<{ here: number; elsewhere: number }>([
    db
      .prepare(
        `SELECT coalesce(sum(chat_id = ?3), 0) AS here, coalesce(sum(chat_id != ?3), 0) AS elsewhere
         FROM recent_messages WHERE user_id = ?1 AND hash = ?2 AND at > ?4`,
      )
      .bind(userId, hash, chatId, since),
    db.prepare(`INSERT INTO recent_messages (user_id, chat_id, hash, at) VALUES (?, ?, ?, ?)`).bind(userId, chatId, hash, now),
  ]);
  return copies.results[0] ?? { here: 0, elsewhere: 0 };
}

export async function prune(
  db: D1Database,
  before: { hashes: number; offenses: number; events: number },
): Promise<void> {
  await db.prepare(`DELETE FROM recent_messages WHERE at <= ?`).bind(before.hashes).run();
  await db.prepare(`DELETE FROM offenses WHERE at <= ?`).bind(before.offenses).run();
  await db.prepare(`DELETE FROM events WHERE at <= ?`).bind(before.events).run();
  await db.prepare(`DELETE FROM spend WHERE hour < ?`).bind(Math.floor(Date.now() / HOUR_MS) - 48).run();
}
