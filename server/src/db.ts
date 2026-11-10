import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  MemberRow,
  MemberState,
  PendingRow,
  Settings,
  UserRow,
} from "./types";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const OFFENSE_WINDOW = 30 * 24 * 60 * 60 * 1000;
const BLOCK_AT = 3;

export class Store {
  private readonly db: Database;
  private writes = 0;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS updates (
        update_id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS updates_created ON updates(created_at);

      CREATE TABLE IF NOT EXISTS members (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        state TEXT NOT NULL,
        observed INTEGER NOT NULL DEFAULT 0,
        offenses INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS message_events (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        length INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_events_user_time
        ON message_events(chat_id, user_id, created_at);
      CREATE INDEX IF NOT EXISTS message_events_time
        ON message_events(created_at);

      CREATE TABLE IF NOT EXISTS pending (
        token TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_expires ON pending(expires_at);
      CREATE INDEX IF NOT EXISTS pending_user ON pending(chat_id, user_id);

      CREATE TABLE IF NOT EXISTS settings (
        chat_id TEXT PRIMARY KEY,
        anti_spam INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        offenses INTEGER NOT NULL DEFAULT 0,
        last_offense_at INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL
      );
    `);
    try {
      this.db.exec("ALTER TABLE settings DROP COLUMN auto_approve");
    } catch {
      // New databases never had the column; older SQLite may not support DROP.
    }
    const now = Date.now();
    this.db
      .query("DELETE FROM updates WHERE created_at < ?")
      .run(now - SEVEN_DAYS);
    this.db
      .query("DELETE FROM message_events WHERE created_at < ?")
      .run(now - 60 * 60 * 1000);
  }

  claimUpdate(updateId: number, now = Date.now()): boolean {
    const row = this.db
      .query<{ update_id: number }, [number, number]>(
        "INSERT OR IGNORE INTO updates (update_id, created_at) VALUES (?, ?) RETURNING update_id",
      )
      .get(updateId, now);
    this.writes += 1;
    if (this.writes % 100 === 0) {
      this.db
        .query("DELETE FROM updates WHERE created_at < ?")
        .run(now - SEVEN_DAYS);
    }
    return row !== null;
  }

  releaseUpdate(updateId: number): void {
    this.db.query("DELETE FROM updates WHERE update_id = ?").run(updateId);
  }

  upsertPending(input: {
    token: string;
    chatId: string;
    userId: string;
    now: number;
    expiresAt: number;
  }): void {
    this.db
      .query("DELETE FROM pending WHERE chat_id = ? AND user_id = ?")
      .run(input.chatId, input.userId);
    this.db
      .query(
        `INSERT INTO pending
          (token, chat_id, user_id, message_id, created_at, expires_at)
         VALUES (?, ?, ?, '', ?, ?)`,
      )
      .run(
        input.token,
        input.chatId,
        input.userId,
        input.now,
        input.expiresAt,
      );
  }

  setPendingMessage(token: string, messageId: string): void {
    this.db
      .query("UPDATE pending SET message_id = ? WHERE token = ?")
      .run(messageId, token);
  }

  getPending(token: string): PendingRow | null {
    return this.db
      .query<PendingRow, [string]>(
        "SELECT * FROM pending WHERE token = ?",
      )
      .get(token);
  }

  consumePending(token: string): PendingRow | null {
    return this.db
      .query<PendingRow, [string]>(
        "DELETE FROM pending WHERE token = ? RETURNING *",
      )
      .get(token);
  }

  deletePending(token: string): void {
    this.db.query("DELETE FROM pending WHERE token = ?").run(token);
  }

  takeExpiredPending(now: number, limit = 20): PendingRow[] {
    return this.db
      .query<PendingRow, [number, number]>(
        `DELETE FROM pending
         WHERE token IN (
           SELECT token FROM pending WHERE expires_at < ? LIMIT ?
         )
         RETURNING *`,
      )
      .all(now, limit);
  }

  ensureMember(
    chatId: string,
    userId: string,
    state: MemberState,
    now: number,
  ): void {
    this.db
      .query(
        `INSERT INTO members (chat_id, user_id, state, observed, offenses, first_seen, last_seen)
         VALUES (?, ?, ?, 0, 0, ?, ?)
         ON CONFLICT(chat_id, user_id) DO UPDATE SET
           state = CASE WHEN state IN ('left', 'banned') THEN excluded.state ELSE state END,
           last_seen = excluded.last_seen`,
      )
      .run(chatId, userId, state, now, now);
  }

  getMember(chatId: string, userId: string): MemberRow | null {
    return this.db
      .query<MemberRow, [string, string]>(
        "SELECT * FROM members WHERE chat_id = ? AND user_id = ?",
      )
      .get(chatId, userId);
  }

  setMemberState(
    chatId: string,
    userId: string,
    state: MemberState,
    now: number,
  ): void {
    this.db
      .query(
        "UPDATE members SET state = ?, last_seen = ? WHERE chat_id = ? AND user_id = ?",
      )
      .run(state, now, chatId, userId);
  }

  bumpObserved(chatId: string, userId: string, now: number): void {
    this.db
      .query(
        "UPDATE members SET observed = observed + 1, last_seen = ? WHERE chat_id = ? AND user_id = ?",
      )
      .run(now, chatId, userId);
  }

  addOffense(chatId: string, userId: string, now: number): void {
    this.db
      .query(
        "UPDATE members SET offenses = offenses + 1, last_seen = ? WHERE chat_id = ? AND user_id = ?",
      )
      .run(now, chatId, userId);
  }

  resetOffenses(chatId: string, userId: string): void {
    this.db
      .query(
        "UPDATE members SET offenses = 0 WHERE chat_id = ? AND user_id = ?",
      )
      .run(chatId, userId);
  }

  recordMessage(
    chatId: string,
    userId: string,
    hash: string,
    length: number,
    now: number,
  ): void {
    this.db
      .query(
        "INSERT INTO message_events (chat_id, user_id, hash, length, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(chatId, userId, hash, length, now);
    this.db
      .query(
        "DELETE FROM message_events WHERE chat_id = ? AND user_id = ? AND created_at < ?",
      )
      .run(chatId, userId, now - 60 * 60 * 1000);
    this.writes += 1;
    if (this.writes % 500 === 0) {
      this.db
        .query("DELETE FROM message_events WHERE created_at < ?")
        .run(now - 60 * 60 * 1000);
    }
  }

  recentStats(
    chatId: string,
    userId: string,
    now: number,
  ): { recent: number; short: number } {
    return this.db
      .query<{ recent: number; short: number }, [number, number, string, string, number]>(
        `SELECT
           COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS recent,
           COALESCE(SUM(CASE WHEN created_at > ? AND length <= 4 THEN 1 ELSE 0 END), 0) AS short
         FROM message_events
         WHERE chat_id = ? AND user_id = ? AND created_at > ?`,
      )
      .get(
        now - 10_000,
        now - 60_000,
        chatId,
        userId,
        now - 60_000,
      )!;
  }

  duplicateCount(
    chatId: string,
    userId: string,
    hash: string,
    now: number,
    windowMs: number,
  ): number {
    const row = this.db
      .query<{ count: number }, [string, string, string, number]>(
        `SELECT COUNT(*) AS count FROM message_events
         WHERE chat_id = ? AND user_id = ? AND hash = ? AND created_at > ?`,
      )
      .get(chatId, userId, hash, now - windowMs);
    return row?.count ?? 0;
  }

  getSettings(chatId: string): Settings {
    const row = this.db
      .query<{ anti_spam: number }, [string]>(
        "SELECT anti_spam FROM settings WHERE chat_id = ?",
      )
      .get(chatId);
    return {
      antiSpam: row ? row.anti_spam === 1 : true,
    };
  }

  private saveSettings(chatId: string, settings: Settings): void {
    this.db
      .query(
        `INSERT INTO settings (chat_id, anti_spam) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET anti_spam = excluded.anti_spam`,
      )
      .run(chatId, settings.antiSpam ? 1 : 0);
  }

  toggleAntiSpam(chatId: string): boolean {
    const settings = this.getSettings(chatId);
    settings.antiSpam = !settings.antiSpam;
    this.saveSettings(chatId, settings);
    return settings.antiSpam;
  }

  getUser(userId: string): UserRow | null {
    return this.db
      .query<UserRow, [string]>(
        "SELECT * FROM users WHERE user_id = ?",
      )
      .get(userId);
  }

  touchUser(userId: string, now: number): void {
    this.db
      .query(
        `INSERT INTO users (user_id, offenses, last_offense_at, last_seen)
         VALUES (?, 0, 0, ?)
         ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(userId, now);
  }

  addUserOffense(userId: string, now: number): void {
    this.db
      .query(
        `INSERT INTO users (user_id, offenses, last_offense_at, last_seen)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           offenses = offenses + 1,
           last_offense_at = excluded.last_offense_at,
           last_seen = excluded.last_seen`,
      )
      .run(userId, now, now);
  }

  isGloballyBlocked(userId: string, now: number): boolean {
    const user = this.getUser(userId);
    return Boolean(
      user &&
        user.offenses >= BLOCK_AT &&
        now - user.last_offense_at < OFFENSE_WINDOW,
    );
  }

  close(): void {
    this.db.close();
  }
}
