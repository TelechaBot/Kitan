// A join attempt's lifecycle as pure data: each status is its own type, and
// `step` maps a state and an event to the next state plus the effects to run.
// No I/O here; db.ts stores attempts and join.ts performs the effects.

export type Delivery =
  | { kind: "guard"; queryId: string }
  | { kind: "dm"; token: string; messageId: number | null };

// ad_profile: the profile reads as an ad. Passing a check proves a person, not an honest
// one, so no check undoes it; a changed profile is audited afresh on the next request.
export type DeclineReason = "kitan_blocklist" | "lols_banned" | "ad_profile";

// What the profile audit concluded, by the weight of the evidence. "ad": a model is confident;
// turned away. "suspect": weaker evidence (a listed word alone), or a model the profile needed
// did not answer (timeout, error, spent budget); the strict check, and when a model was
// missing the audit is finished before approval (recheck).
export type Screening = "ad" | "suspect" | "clean";

interface Base {
  id: number;
  chatId: string;
  chatTitle: string | null;
  userId: string;
  delivery: Delivery;
  createdAt: number;
  expiresAt: number;
  misses: number; // recent checks this person let lapse in this group (see patience)
  // A profile the audit flagged gets two Turnstile checks and one arithmetic question,
  // shuffled; null is the ordinary single Turnstile check.
  challenge: ChallengeState | null;
}

export type StepKind = "cf" | "math";

// One strict check's progress. `steps` is fixed at creation, so the client can be told
// only the current step; `index` moves forward under an atomic write in db.ts.
export interface ChallengeState {
  steps: StepKind[];
  index: number;
  math: { question: string; answer: number };
  recheck?: true; // the audit was incomplete: finish it before letting them in
}

// What the Mini App is told about the current step. Never the answer or future steps.
export interface PublicStep {
  kind: StepKind;
  index: number;
  total: number;
  question?: string;
}

// Two Turnstile checks and one sum, in every shuffled order.
const STRICT_STEPS: StepKind[][] = [
  ["cf", "cf", "math"],
  ["cf", "math", "cf"],
  ["math", "cf", "cf"],
];

// a and b are 10..49; subtraction keeps the larger first so the answer is never negative.
export function newMathQuestion(): { question: string; answer: number } {
  const bytes = new Uint32Array(3);
  crypto.getRandomValues(bytes);
  const a = 10 + (bytes[0] % 40);
  const b = 10 + (bytes[1] % 40);
  if (bytes[2] % 2 === 0) {
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    return { question: `${high} - ${low}`, answer: high - low };
  }
  return { question: `${a} + ${b}`, answer: a + b };
}

export function createStrictChallenge(): ChallengeState {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return {
    steps: STRICT_STEPS[bytes[0] % STRICT_STEPS.length].slice(),
    index: 0,
    math: newMathQuestion(),
  };
}

export function publicStep(c: ChallengeState): PublicStep {
  const kind = c.steps[c.index];
  return kind === "math"
    ? { kind, index: c.index, total: c.steps.length, question: c.math.question }
    : { kind, index: c.index, total: c.steps.length };
}

// "screening": the profile audit is running in the background; nothing is sent yet.
// Waiting states have a deadline like pending ones, because a join request
// nobody answers locks the person out: they cannot ask again until it is
// declined. "unreachable": Telegram would not let the bot DM this person
// first; pressing Start in the bot before the deadline resumes the check.
// "queued": the check could not be sent; the admins may decide first.
export type Attempt =
  | (Base & { status: "screening" })
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
  | { type: "screened"; verdict: Screening; recheck: boolean; strict: ChallengeState; at: number }
  // They passed the check, but the finished audit reads the profile as an ad.
  | { type: "rejected"; at: number }
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
// "challenge": send the check. "notify_ad": tell the person why they were turned away and
// that asking again gets the strict check; it must go before the decline, because the bot
// may write to a requester only until the request is answered.
export type JoinEffect =
  | { type: "answer"; result: "approve" | "decline" | "queue"; queryUsed?: true }
  | { type: "challenge" }
  | { type: "notify_ad" };

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
// The audit runs after the webhook answers; a Worker evicted mid-audit leaves the attempt
// screening, and the cron declines it after this so the person can ask again.
export const SCREEN_TTL_MS = 2 * 60 * 1000;

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

// The first state of a new join request: declined at the door, or screening, which the
// audit's "screened" event moves on.
export function intake(input: Intake): { attempt: NewAttempt; effects: JoinEffect[] } {
  const base = {
    chatId: input.chatId,
    chatTitle: input.chatTitle,
    userId: input.userId,
    delivery: input.delivery,
    createdAt: input.at,
    expiresAt: input.at + SCREEN_TTL_MS,
    misses: input.misses,
    challenge: null,
  };
  const reason: DeclineReason | null = input.blocked ? "kitan_blocklist" : input.lols ? "lols_banned" : null;
  return reason
    ? {
        attempt: { ...base, status: "declined", decidedAt: input.at, reason },
        effects: [{ type: "answer", result: "decline" }],
      }
    : { attempt: { ...base, status: "screening" }, effects: [] };
}

function checkTtl(a: Attempt): number {
  return patience(a.delivery.kind === "guard" ? GUARD_TTL_MS : DM_TTL_MS, CHECK_CAP_MS, a.misses);
}

export function step(a: Attempt, e: JoinEvent): Step {
  switch (e.type) {
    case "screened": {
      if (a.status !== "screening") return refuse(a);
      if (e.verdict === "ad") return declineAd(a, e.at);
      const challenge = e.verdict === "clean" ? null : e.recheck ? { ...e.strict, recheck: true as const } : e.strict;
      return ok({ ...a, status: "pending", challenge, expiresAt: e.at + checkTtl(a) }, { type: "challenge" });
    }

    case "rejected": {
      const refusal = openForUser(a, e.at);
      if (refusal) return { ok: false, reason: refusal };
      return declineAd(a, e.at);
    }

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
  return a.status === "screening" || a.status === "pending" || a.status === "unreachable" || a.status === "queued";
}

// Whether the user can still open and submit the check; the reason when not.
export function openForUser(a: Attempt, at: number): Refusal | null {
  if (a.status === "approved") return "already_verified";
  if (a.status !== "pending" || at > a.expiresAt) return "closed";
  return null;
}

function declineAd(a: Attempt, at: number): Step {
  return ok(
    { ...a, status: "declined", decidedAt: at, reason: "ad_profile" },
    { type: "notify_ad" },
    { type: "answer", result: "decline" },
  );
}

function toPending(a: Attempt): Attempt {
  const { id, chatId, chatTitle, userId, delivery, createdAt, expiresAt, misses, challenge } = a;
  return { id, chatId, chatTitle, userId, delivery, createdAt, expiresAt, misses, challenge, status: "pending" };
}

function ok(next: Attempt, ...effects: JoinEffect[]): Step {
  return { ok: true, next, effects };
}

function refuse(a: Attempt): Step {
  const reason: Refusal = a.status === "approved" ? "already_verified" : isWaiting(a) ? "not_due" : "closed";
  return { ok: false, reason };
}
