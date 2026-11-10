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
}

// "unreachable": Telegram would not let the bot DM this person first. The
// request stays with the admins until the person presses Start in the bot,
// which resumes the check.
export type Attempt =
  | (Base & { status: "pending" })
  | (Base & { status: "unreachable"; decidedAt: number; error: string })
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

// The answer Telegram gets for the join request; "queue" hands it to the group's admins.
export type JoinEffect = { type: "answer"; result: "approve" | "decline" | "queue" };

export type Step = { ok: true; next: Attempt; effects: JoinEffect[] } | { ok: false; reason: Refusal };

// Why an event does not apply: the user already passed, the attempt is not open
// to them (expired, failed, declined, or unreachable until they start the
// bot), or a pending attempt is not yet due to expire.
export type Refusal = "already_verified" | "closed" | "not_due";

export const GUARD_TTL_MS = 10 * 60 * 1000;
export const DM_TTL_MS = 5 * 60 * 1000;

export interface Intake {
  chatId: string;
  chatTitle: string | null;
  userId: string;
  delivery: Delivery;
  blocked: boolean;
  lols: boolean | null;
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
    expiresAt: input.at + (input.delivery.kind === "guard" ? GUARD_TTL_MS : DM_TTL_MS),
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

    case "challenge_failed":
      // A real person may be behind it either way, so the admins get the request.
      if (a.status !== "pending") return refuse(a);
      if (e.refused && a.delivery.kind === "dm") {
        return ok({ ...a, status: "unreachable", decidedAt: e.at, error: e.error });
      }
      return ok({ ...a, status: "failed", decidedAt: e.at, error: e.error }, { type: "answer", result: "queue" });

    case "resumed":
      // The person started the bot; give them a fresh time limit from now.
      if (a.status !== "unreachable") return refuse(a);
      return ok({ ...toPending(a), expiresAt: e.at + DM_TTL_MS });

    case "verified": {
      const refusal = openForUser(a, e.at);
      if (refusal) return { ok: false, reason: refusal };
      return ok({ ...a, status: "approved", decidedAt: e.at }, { type: "answer", result: "approve" });
    }

    case "approve_failed":
      if (a.status !== "approved") return refuse(a);
      // Gone: the request was withdrawn or answered elsewhere. Otherwise the user may retry.
      return e.gone ? ok({ ...a, status: "failed", decidedAt: e.at, error: e.error }) : ok(toPending(a));

    case "tick":
      if (a.status !== "pending" || e.at < a.expiresAt) return refuse(a);
      return ok({ ...a, status: "expired", decidedAt: e.at }, { type: "answer", result: "decline" });
  }
}

// Whether the user can still open and submit the check; the reason when not.
export function openForUser(a: Attempt, at: number): Refusal | null {
  if (a.status === "approved") return "already_verified";
  if (a.status !== "pending" || at > a.expiresAt) return "closed";
  return null;
}

function toPending(a: Attempt): Attempt {
  const { id, chatId, chatTitle, userId, delivery, createdAt, expiresAt } = a;
  return { id, chatId, chatTitle, userId, delivery, createdAt, expiresAt, status: "pending" };
}

function ok(next: Attempt, ...effects: JoinEffect[]): Step {
  return { ok: true, next, effects };
}

function refuse(a: Attempt): Step {
  const reason: Refusal = a.status === "approved" ? "already_verified" : a.status === "pending" ? "not_due" : "closed";
  return { ok: false, reason };
}
