// The one profile audit, for both ways into a group: a join request, and joining directly
// (an open group, an invite link, another bot's check). Keywords first; then the text
// model when the profile points somewhere, and the image model on the avatar.
import type { Screening } from "./attempt";
import {
  type Decision,
  type Dossier,
  type ModelVerdict,
  NEURONS,
  decideText,
  forModels,
  judgeAvatar,
  judgeText,
  modelsPaused,
} from "./classify";
import { recordSpend, spentToday } from "./db";
import { bannedWords } from "./lexicon";
import { type Target, diversionTargets, strong } from "./probation";
import type { Env } from "./types";

export const DAILY_NEURONS = 7000; // leaves room for bench runs under the 10,000 allowance

// The audit runs after the webhook has answered, inside waitUntil's 30 seconds. A 4-second
// limit inside the webhook cut off 378 of 713 join-request audits (2026-11-04..18), and each
// cut-off one was let through with the ordinary check.
const MODEL_TIMEOUT_MS = 20_000;

export interface ProfileAudit {
  verdict: Screening;
  lexicon: string[];
  targets: Target[];
  missing: ("text" | "avatar")[]; // needed, not answered: timeout, error, paused or no budget
  decision: Decision | null;
  text_model: ModelVerdict | null;
  avatar_model: ModelVerdict | null;
}

export interface Answers {
  needText: boolean;
  needAvatar: boolean;
  decision: Decision | null;
  text: ModelVerdict | null;
  avatar: ModelVerdict | null;
}

// Ad on either model's confident answer, at the thresholds production measured with no false
// positive; unknown when a model the profile needed did not answer.
export function screening(a: Answers): { verdict: Screening; missing: ("text" | "avatar")[] } {
  const textAd = a.decision !== null && a.decision.p >= 0.9 && a.text !== null && a.text.ad && a.text.confidence >= 0.85;
  const avatarAd = a.avatar !== null && a.avatar.ad && a.avatar.confidence >= 0.9;
  const missing: ("text" | "avatar")[] = [];
  if (a.needText && (a.decision === null || a.text === null)) missing.push("text");
  if (a.needAvatar && a.avatar === null) missing.push("avatar");
  return { verdict: textAd || avatarAd ? "ad" : missing.length > 0 ? "unknown" : "clean", missing };
}

export async function auditProfile(env: Env, dossier: Dossier, avatarId: string | null, now: number): Promise<ProfileAudit> {
  const lexicon = bannedWords([dossier.name, dossier.username, dossier.bio, dossier.personalChat].filter(Boolean).join(" "));
  const targets = diversionTargets({ name: dossier.name, bio: dossier.bio, channel: dossier.personalChat }).map((t) => ({
    ...t,
    value: t.value.slice(0, 80),
  }));
  const none = { lexicon, targets, missing: [], decision: null, text_model: null, avatar_model: null };
  if (lexicon.length > 0) return { ...none, verdict: "ad" };
  const needText = targets.some(strong);
  const needAvatar = avatarId !== null;
  if (!needText && !needAvatar) return { ...none, verdict: "clean" };

  const spent = modelsPaused(now) ? Number.POSITIVE_INFINITY : await spentToday(env.DB, now);
  const textCost = NEURONS.decision + NEURONS.verdict;
  const askText = needText && spent + textCost <= DAILY_NEURONS;
  const askAvatar = needAvatar && spent + (askText ? textCost : 0) + NEURONS.image <= DAILY_NEURONS;
  const view = forModels(dossier);
  const [decision, text, avatar] = await Promise.all([
    askText ? bounded(decideText(env, view)) : null,
    askText ? bounded(judgeText(env, view)) : null,
    askAvatar && avatarId ? bounded(judgeAvatar(env, avatarId, view)) : null,
  ]);
  const cost = (askText ? textCost : 0) + (askAvatar ? NEURONS.image : 0);
  if (cost > 0) await recordSpend(env.DB, cost, now);
  return { ...none, ...screening({ needText, needAvatar, decision, text, avatar }), decision, text_model: text, avatar_model: avatar };
}

async function bounded<T>(work: Promise<T | null>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), MODEL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
