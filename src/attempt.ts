// A join attempt's lifecycle as pure data: each status is its own type, and
// `step` maps a state and an event to the next state plus the effects to run.
// No I/O here; db.ts stores attempts and join.ts performs the effects.

export type Delivery =
  | { kind: "guard"; queryId: string }
  | { kind: "dm"; token: string; messageId: number | null };

export type DeclineReason = "kitan_blocklist" | "lols_banned";

interface Base {
  id: number;
  chatId: string;
  chatTitle: string | null;
  userId: string;
  delivery: Delivery;
  createdAt: number;
  expiresAt: number;
  misses: number; // recent checks this person let lapse in this group (see patience)
}

// Waiting states have a deadline like pending ones, because a join request
// nobody answers locks the person out: they cannot ask again until it is
// declined. "unreachable": Telegram would not let the bot DM this person
// first; pressing Start in the bot before the deadline resumes the check.
// "queued": the check could not be sent; the admins may decide first.
export type Attempt =
  | (Base & { status: "pending" })
  | (Base & { status: "unreachable"; decidedAt: number; error: string })
  | (Base & { status: "queued"; decidedAt: number; error: string })
  | (Base & { status: "approved"; decidedAt: number })
  | (Base & { status: "expired"; decidedAt: number })
  | (Base & { status: "failed"; decidedAt: number; error: string })
  | (Base & { status: "declined"; decidedAt: number; reason: DeclineReason });

// An attempt before storage gives it an id. Omit applied per variant, keeping each status's fields.
export type NewAttempt = Attempt extends infer A ? (A extends Attempt ? Omit<A, "id"> : never) : never;

export type JoinEvent =
  | { type: "challenged"; messageId: number | null }
  // `refused`: Telegram forbids the bot to start this conversation (see telegram.ts).
  | { type: "challenge_failed"; error: string; refused: boolean; at: number }
  | { type: "resumed"; at: number }
  | { type: "verified"; at: number }
  | { type: "approve_failed"; gone: boolean; error: string; at: number }
  | { type: "tick"; at: number };

// The answer Telegram gets for the join request; "queue" hands it to the group's
// admins. `queryUsed`: the guard-bot query was already answered with "queue",
// so the request must be answered directly.
export type JoinEffect = { type: "answer"; result: "approve" | "decline" | "queue"; queryUsed?: true };

export type Step = { ok: true; next: Attempt; effects: JoinEffect[] } | { ok: false; reason: Refusal };

// Why an event does not apply: the user already passed, the attempt is closed
// to them, or a waiting attempt is not yet due to expire.
export type Refusal = "already_verified" | "closed" | "not_due";

// Time limits for a first try. Each check the person let lapse in this group
// recently triples the next one, up to a cap: people who slipped up come back
// and get more time, while bulk accounts, which almost never ask twice, keep
// the short one. Nothing waits past the cap, so no request is left forever.
export const GUARD_TTL_MS = 10 * 60 * 1000;
export const DM_TTL_MS = 5 * 60 * 1000;
export const CHECK_CAP_MS = 6 * 60 * 60 * 1000;
// How long an unreachable or queued request waits before Kitan declines it so the person can ask again.
export const WAIT_TTL_MS = 60 * 60 * 1000;
export const WAIT_CAP_MS = 24 * 60 * 60 * 1000;
export const MISS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function patience(baseMs: number, capMs: number, misses: number): number {
  return Math.min(baseMs * 3 ** misses, capMs);
}

export interface Intake {
  chatId: string;
  chatTitle: string | null;
  userId: string;
  delivery: Delivery;
  blocked: boolean;
  lols: boolean | null;
  misses: number;
  at: number;
}

// The first state of a new join request: declined at the door, or pending, which
// the caller answers by sending the challenge.
export function intake(input: Intake): { attempt: NewAttempt; effects: JoinEffect[] } {
  const base = {
    chatId: input.chatId,
    chatTitle: input.chatTitle,
    userId: input.userId,
    delivery: input.delivery,
    createdAt: input.at,
    expiresAt:
      input.at + patience(input.delivery.kind === "guard" ? GUARD_TTL_MS : DM_TTL_MS, CHECK_CAP_MS, input.misses),
    misses: input.misses,
  };
  const reason: DeclineReason | null = input.blocked ? "kitan_blocklist" : input.lols ? "lols_banned" : null;
  return reason
    ? {
        attempt: { ...base, status: "declined", decidedAt: input.at, reason },
        effects: [{ type: "answer", result: "decline" }],
      }
    : { attempt: { ...base, status: "pending" }, effects: [] };
}

export function step(a: Attempt, e: JoinEvent): Step {
  switch (e.type) {
    case "challenged":
      if (a.status !== "pending") return refuse(a);
      return a.delivery.kind === "dm"
        ? ok({ ...a, delivery: { ...a.delivery, messageId: e.messageId } })
        : ok(a);

    case "challenge_failed": {
      // A real person may be behind it either way: wait for them or the admins, but not forever.
      if (a.status !== "pending") return refuse(a);
      const waiting = {
        ...a,
        decidedAt: e.at,
        error: e.error,
        expiresAt: e.at + patience(WAIT_TTL_MS, WAIT_CAP_MS, a.misses),
      };
      return e.refused && a.delivery.kind === "dm"
        ? ok({ ...waiting, status: "unreachable" })
        : ok({ ...waiting, status: "queued" }, { type: "answer", result: "queue" });
    }

    case "resumed":
      // The person started the bot; give them a fresh time limit from now.
      if (a.status !== "unreachable") return refuse(a);
      return ok({ ...toPending(a), expiresAt: e.at + patience(DM_TTL_MS, CHECK_CAP_MS, a.misses) });

    case "verified": {
      const refusal = openForUser(a, e.at);
      if (refusal) return { ok: false, reason: refusal };
      return ok({ ...a, status: "approved", decidedAt: e.at }, { type: "answer", result: "approve" });
    }

    case "approve_failed":
      if (a.status !== "approved") return refuse(a);
      // Gone: the request was withdrawn or answered elsewhere. Otherwise the user may retry.
      return e.gone ? ok({ ...a, status: "failed", decidedAt: e.at, error: e.error }) : ok(toPending(a));

    case "tick": {
      if (!isWaiting(a) || e.at < a.expiresAt) return refuse(a);
      const decline: JoinEffect =
        a.status === "queued" && a.delivery.kind === "guard"
          ? { type: "answer", result: "decline", queryUsed: true }
          : { type: "answer", result: "decline" };
      return ok({ ...a, status: "expired", decidedAt: e.at }, decline);
    }
  }
}

// States that hold an open join request on Telegram and so must end by their deadline.
export function isWaiting(a: Attempt): boolean {
  return a.status === "pending" || a.status === "unreachable" || a.status === "queued";
}

// Whether the user can still open and submit the check; the reason when not.
export function openForUser(a: Attempt, at: number): Refusal | null {
  if (a.status === "approved") return "already_verified";
  if (a.status !== "pending" || at > a.expiresAt) return "closed";
  return null;
}

function toPending(a: Attempt): Attempt {
  const { id, chatId, chatTitle, userId, delivery, createdAt, expiresAt, misses } = a;
  return { id, chatId, chatTitle, userId, delivery, createdAt, expiresAt, misses, status: "pending" };
}

function ok(next: Attempt, ...effects: JoinEffect[]): Step {
  return { ok: true, next, effects };
}

function refuse(a: Attempt): Step {
  const reason: Refusal = a.status === "approved" ? "already_verified" : isWaiting(a) ? "not_due" : "closed";
  return { ok: false, reason };
}
