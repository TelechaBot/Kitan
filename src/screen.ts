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
// positive. gemma-4 gives confidence in steps (0.8, 0.9, 0.95, 1); at 0.9 it still turned away
// people whose bio points to their own channel, at 0.95 none of those in bench/models.ts
// (2026-11-21), for 2 of 89 ads. A listed word alone is suspect, not ad: "需要邀请链接的请私聊"
// on a fan group's owner matched 私密群, and that person had to lift a mute (2026-11). So is a
// needed model that did not answer.
export function screening(a: Answers & { lexicon: number }): { verdict: Screening; missing: ("text" | "avatar")[] } {
  const textAd = a.decision !== null && a.decision.p >= 0.9 && a.text !== null && a.text.ad && a.text.confidence >= 0.95;
  const avatarAd = a.avatar !== null && a.avatar.ad && a.avatar.confidence >= 0.9;
  const missing: ("text" | "avatar")[] = [];
  if (a.needText && (a.decision === null || a.text === null)) missing.push("text");
  if (a.needAvatar && a.avatar === null) missing.push("avatar");
  const verdict = textAd || avatarAd ? "ad" : a.lexicon > 0 || missing.length > 0 ? "suspect" : "clean";
  return { verdict, missing };
}

export async function auditProfile(
  env: Env,
  dossier: Dossier,
  avatarId: string | null,
  now: number,
  timeoutMs = MODEL_TIMEOUT_MS,
): Promise<ProfileAudit> {
  const lexicon = bannedWords([dossier.name, dossier.username, dossier.bio, dossier.personalChat].filter(Boolean).join(" "));
  const targets = diversionTargets({ name: dossier.name, bio: dossier.bio, channel: dossier.personalChat }).map((t) => ({
    ...t,
    value: t.value.slice(0, 80),
  }));
  const none = { lexicon, targets, missing: [], decision: null, text_model: null, avatar_model: null };
  const needText = targets.some(strong);
  const needAvatar = avatarId !== null;
  if (!needText && !needAvatar) return { ...none, ...screening({ needText, needAvatar, decision: null, text: null, avatar: null, lexicon: lexicon.length }) };

  const spent = modelsPaused(now) ? Number.POSITIVE_INFINITY : await spentToday(env.DB, now);
  const textCost = NEURONS.decision + NEURONS.verdict;
  const askText = needText && spent + textCost <= DAILY_NEURONS;
  const askAvatar = needAvatar && spent + (askText ? textCost : 0) + NEURONS.image <= DAILY_NEURONS;
  const view = forModels(dossier);
  const [decision, text, avatar] = await Promise.all([
    askText ? bounded(decideText(env, view), timeoutMs) : null,
    askText ? bounded(judgeText(env, view), timeoutMs) : null,
    askAvatar && avatarId ? bounded(judgeAvatar(env, avatarId, view), timeoutMs) : null,
  ]);
  // Only answers are billed: from 2026-11-20 a retired model failed every call, and booking those
  // spent the day's budget on nothing, so the avatar model was skipped too.
  const cost = (decision ? NEURONS.decision : 0) + (text ? NEURONS.verdict : 0) + (avatar ? NEURONS.image : 0);
  if (cost > 0) await recordSpend(env.DB, cost, now);
  const verdict = screening({ needText, needAvatar, decision, text, avatar, lexicon: lexicon.length });
  return { ...none, ...verdict, decision, text_model: text, avatar_model: avatar };
}

async function bounded<T>(work: Promise<T | null>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
