// An account's behaviour across every Kitan group, kept as a small sketch rather than
// a message log: rhythm, daily pattern, lifecycle, and what its messages contain, both
// lately and over the long run. The gap between those two is how a farmed account
// shows itself: weeks of "大家好" and "哈哈哈", then links and bot handles.
// Pure: step() folds one event in, features() turns a sketch into a model input.

export interface Mix {
  link: number;
  mention: number;
  forward: number;
  media: number;
  length: number; // log(1 + characters)
}

export interface Trajectory {
  messages: number;
  edits: number;
  joins: number;
  chats: number; // groups they have spoken in
  firstAt: number | null;
  lastAt: number | null;
  lastJoinAt: number | null;
  firstReplyMinutes: number | null; // join to first message, the quickest seen
  gaps: { n: number; mean: number; m2: number }; // log seconds between messages (Welford)
  bursts: number; // messages within 10 s of the previous one
  hours: number[]; // messages per UTC hour of day
  recent: Mix; // fast moving average (≈ last 3 messages)
  usual: Mix; // slow moving average (≈ last 30 messages)
}

export type Activity =
  | { kind: "join"; at: number }
  | { kind: "edit"; at: number }
  | { kind: "message"; at: number; newChat: boolean; link: boolean; mention: boolean; forward: boolean; media: boolean; chars: number };

const RECENT = 0.3;
const USUAL = 0.03;
const BURST_S = 10;

const blank = (): Mix => ({ link: 0, mention: 0, forward: 0, media: 0, length: 0 });

export function empty(): Trajectory {
  return {
    messages: 0,
    edits: 0,
    joins: 0,
    chats: 0,
    firstAt: null,
    lastAt: null,
    lastJoinAt: null,
    firstReplyMinutes: null,
    gaps: { n: 0, mean: 0, m2: 0 },
    bursts: 0,
    hours: Array(24).fill(0),
    recent: blank(),
    usual: blank(),
  };
}

export function step(t: Trajectory, a: Activity): Trajectory {
  if (a.kind === "join") return { ...t, joins: t.joins + 1, lastJoinAt: a.at };
  if (a.kind === "edit") return { ...t, edits: t.edits + 1 };

  const mix: Mix = {
    link: Number(a.link),
    mention: Number(a.mention),
    forward: Number(a.forward),
    media: Number(a.media),
    length: Math.log1p(a.chars),
  };
  const blend = (old: Mix, rate: number): Mix =>
    t.messages === 0
      ? mix
      : {
          link: old.link + rate * (mix.link - old.link),
          mention: old.mention + rate * (mix.mention - old.mention),
          forward: old.forward + rate * (mix.forward - old.forward),
          media: old.media + rate * (mix.media - old.media),
          length: old.length + rate * (mix.length - old.length),
        };

  let gaps = t.gaps;
  let bursts = t.bursts;
  if (t.lastAt !== null) {
    const seconds = Math.max(0, (a.at - t.lastAt) / 1000);
    if (seconds < BURST_S) bursts += 1;
    const x = Math.log1p(seconds);
    const n = gaps.n + 1;
    const delta = x - gaps.mean;
    const mean = gaps.mean + delta / n;
    gaps = { n, mean, m2: gaps.m2 + delta * (x - mean) };
  }
  const firstAfterJoin = t.lastJoinAt !== null && (t.lastAt === null || t.lastAt < t.lastJoinAt);
  const reply = firstAfterJoin ? (a.at - t.lastJoinAt!) / 60_000 : null;
  const hours = [...t.hours];
  hours[new Date(a.at).getUTCHours()] += 1;

  return {
    ...t,
    messages: t.messages + 1,
    chats: t.chats + Number(a.newChat),
    firstAt: t.firstAt ?? a.at,
    lastAt: a.at,
    firstReplyMinutes: reply === null ? t.firstReplyMinutes : Math.min(reply, t.firstReplyMinutes ?? Infinity),
    gaps,
    bursts,
    hours,
    recent: blend(t.recent, RECENT),
    usual: blend(t.usual, USUAL),
  };
}

export const FEATURES = [
  "log_messages", "log_chats", "log_joins", "account_years", "per_active_day",
  "gap_mean", "gap_spread", "burst_share", "hour_entropy", "edit_share", "log_first_reply",
  "link", "mention", "forward", "media", "length",
  "shift_link", "shift_mention", "shift_forward", "shift_media", "shift_length",
] as const;

// Telegram ids grow over time: roughly 1e9 in 2020 and 8.8e9 by mid-2026.
function accountYears(userId: number, now: number): number {
  const registered = 2020 + ((userId - 1.2e9) / (8.8e9 - 1.2e9)) * 6.4;
  return Math.max(0, new Date(now).getUTCFullYear() + new Date(now).getUTCMonth() / 12 - registered);
}

export function features(t: Trajectory, userId: number, now: number): number[] {
  const days = t.firstAt !== null && t.lastAt !== null ? Math.max(1, (t.lastAt - t.firstAt) / 86_400_000) : 1;
  const total = t.hours.reduce((s, h) => s + h, 0);
  const entropy = total
    ? -t.hours.filter(Boolean).reduce((s, h) => s + (h / total) * Math.log(h / total), 0) / Math.log(24)
    : 0;
  return [
    Math.log1p(t.messages),
    Math.log1p(t.chats),
    Math.log1p(t.joins),
    accountYears(userId, now),
    t.messages / days,
    t.gaps.mean,
    t.gaps.n > 1 ? Math.sqrt(t.gaps.m2 / (t.gaps.n - 1)) : 0,
    t.messages ? t.bursts / t.messages : 0,
    entropy,
    t.messages ? t.edits / t.messages : 0,
    t.firstReplyMinutes === null ? -1 : Math.log1p(t.firstReplyMinutes),
    t.usual.link,
    t.usual.mention,
    t.usual.forward,
    t.usual.media,
    t.usual.length,
    t.recent.link - t.usual.link,
    t.recent.mention - t.usual.mention,
    t.recent.forward - t.usual.forward,
    t.recent.media - t.usual.media,
    t.recent.length - t.usual.length,
  ];
}
