// Replays production footprints through the profile audit's decision (src/screen.ts) and
// the join state machine's rule, without calling a model: what each door would have done
// with the answers the models actually gave. Data stays outside the repo (real people).
//
//   bun bench/replay.ts export ~/.cache/kitan-bench/prod
//   bun bench/simulate.ts ~/.cache/kitan-bench/prod
//
// Labels are proxies: "kicked" = removed by a human admin after getting in (an ad nobody
// else caught); "talked" = later replied to someone or was replied to (likely a person).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AD_REPEAT_MS, type Screening } from "../src/attempt";
import { bannedWords } from "../src/lexicon";
import { diversionTargets, strong } from "../src/probation";
import { screening } from "../src/screen";

const dir = process.argv[2] ?? join(process.env.HOME ?? ".", ".cache/kitan-bench/prod");
const read = (name: string) =>
  readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

interface Event {
  at: number;
  chat_id: string;
  user_id: string;
  kind: string;
  detail: Record<string, any>;
}
const events: Event[] = read("events.jsonl")
  .map((e: any) => ({ ...e, detail: JSON.parse(e.detail) }))
  .sort((a: Event, b: Event) => a.at - b.at);
const attempts = read("attempts.jsonl").sort((a: any, b: any) => a.created_at - b.created_at);
const since = events[0]?.at ?? 0;

const byUser = new Map<string, Event[]>();
for (const e of events) (byUser.get(e.user_id) ?? byUser.set(e.user_id, []).get(e.user_id)!).push(e);

function kickedByHuman(chat: string, user: string, after: number): boolean {
  return (byUser.get(user) ?? []).some(
    (e) => e.kind === "leave" && e.chat_id === chat && e.at >= after && e.detail.status === "kicked" && String(e.detail.by).startsWith("user:"),
  );
}
function talked(user: string, after: number): boolean {
  return (byUser.get(user) ?? []).some(
    (e) => e.kind === "message" && e.at >= after && ((e.detail.social?.replies ?? 0) > 0 || (e.detail.social?.repliedBy ?? 0) > 0),
  );
}
// The profile as last read at or before `at`.
function profileAt(user: string, at: number): Record<string, any> | null {
  return (byUser.get(user) ?? []).filter((e) => e.kind === "profile" && e.at <= at + 5_000 && !e.detail.error).at(-1)?.detail ?? null;
}

function verdictOf(lexicon: string[], needText: boolean, needAvatar: boolean, v: Record<string, any> | null): Screening {
  if (lexicon.length > 0) return "ad";
  if (!needText && !needAvatar) return "clean";
  return screening({ needText, needAvatar, decision: v?.decision ?? null, text: v?.text_model ?? null, avatar: v?.avatar_model ?? null }).verdict;
}

// ---------- the join-request door ----------

type Row = Record<string, number>;
const door: Record<string, Row> = {};
const tally = (table: Record<string, Row>, key: string, col: string) => {
  table[key] ??= {};
  table[key][col] = (table[key][col] ?? 0) + 1;
};
const turnedAway = new Map<string, number>(); // chat:user -> last ad decline
const examples: string[] = [];

for (const a of attempts) {
  if (a.created_at < since) continue;
  const request = (byUser.get(a.user_id) ?? []).find((e) => e.kind === "join_request" && e.chat_id === a.chat_id && Math.abs(e.at - a.created_at) < 5_000);
  if (!request) continue;
  const verdict = (byUser.get(a.user_id) ?? []).find(
    (e) => e.kind === "verdict" && e.detail.on === "join_request" && e.chat_id === a.chat_id && Math.abs(e.at - a.created_at) < 30_000,
  )?.detail ?? null;
  const profile = profileAt(a.user_id, a.created_at);
  const bio = request.detail.bio || profile?.bio || undefined;
  const name = request.detail.name ?? "";
  const lexicon = bannedWords([name, request.detail.username, bio, profile?.personal_chat].filter(Boolean).join(" "));
  const needText = diversionTargets({ name, bio, channel: profile?.personal_chat ?? undefined }).some(strong);
  const needAvatar = profile?.has_photo === true;
  const v = verdictOf(lexicon, needText, needAvatar, verdict);
  const key = `${a.chat_id}:${a.user_id}`;
  const last = turnedAway.get(key);
  const repeat = last !== undefined && a.created_at - last < AD_REPEAT_MS;
  const now = a.error === "kitan_blocklist" || a.error === "lols_banned"
    ? "declined (blocklist/lols)"
    : v === "ad" && !repeat
      ? "declined (ad profile)"
      : v === "clean"
        ? "ordinary check"
        : `strict check (${v === "ad" ? "asked again" : "audit unfinished"})`;
  if (now === "declined (ad profile)") turnedAway.set(key, a.created_at);
  const before = a.status === "declined" ? "declined" : `${a.challenge ? "strict" : "ordinary"} → ${a.status}`;
  tally(door, now, before);
  if (a.status === "approved") {
    if (kickedByHuman(a.chat_id, a.user_id, a.created_at)) tally(door, now, "· of approved: kicked by an admin");
    if (talked(a.user_id, a.created_at)) tally(door, now, "· of approved: talked with people");
    if (now.startsWith("declined") && examples.length < 12) examples.push(`${now} ← was ${before}: ${name} | ${(bio ?? "").slice(0, 50)}`);
  }
}

// ---------- the direct door (open group, invite link, another bot) ----------

const direct: Record<string, Row> = {};
const removed = new Map<string, number>();
for (const j of events) {
  if (j.kind !== "join" || j.detail.by_kitan || String(j.detail.approved_by ?? "").startsWith("user:")) continue;
  const verdict = (byUser.get(j.user_id) ?? []).find((e) => e.kind === "verdict" && e.detail.on === "profile" && e.chat_id === j.chat_id && e.at >= j.at && e.at - j.at < 60_000)?.detail ?? null;
  const profile = profileAt(j.user_id, j.at);
  const name = j.detail.name ?? "";
  const bio = profile?.bio ?? undefined;
  const lexicon = bannedWords([name, j.detail.username, bio, profile?.personal_chat].filter(Boolean).join(" "));
  const needText = diversionTargets({ name, bio, channel: profile?.personal_chat ?? undefined }).some(strong);
  const v = verdictOf(lexicon, needText, false, verdict);
  const key = `${j.chat_id}:${j.user_id}`;
  const last = removed.get(key);
  const act = v !== "ad" ? `left in (${v})` : last !== undefined && j.at - last < AD_REPEAT_MS ? "muted until the strict check" : "removed";
  if (act === "removed") removed.set(key, j.at);
  tally(direct, act, "joins");
  if (kickedByHuman(j.chat_id, j.user_id, j.at)) tally(direct, act, "kicked by an admin anyway");
  if (talked(j.user_id, j.at)) tally(direct, act, "talked with people");
  if ((byUser.get(j.user_id) ?? []).some((e) => e.kind === "message" && e.chat_id === j.chat_id && e.at >= j.at)) tally(direct, act, "posted");
}

const days = ((events.at(-1)?.at ?? 0) - since) / 86_400_000;
console.log(`Footprints over ${days.toFixed(1)} days\n\nJoin requests: new outcome (rows) by what happened (columns)`);
console.table(door);
console.log("Approved before, declined now (sample):");
for (const e of examples) console.log(`  ${e}`);
console.log("\nDirect joins: new action by what happened after");
console.table(direct);
