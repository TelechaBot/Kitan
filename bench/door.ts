// The door benchmark: how each admission policy treats ad accounts and people, scored on
// production cases with labels that do not come from the policies themselves.
//
//   bun bench/replay.ts export ~/.cache/kitan-bench/prod   # D1 tables → jsonl (private data)
//   bun bench/door.ts cases                                # freeze the labelled cases
//   bun bench/door.ts score                                # policies × labels → bench/BASELINE.md numbers
//   bun bench/door.ts sheet 100                            # a random unlabelled sample to label by hand
//   bun bench/door.ts live [hours]                         # the same doors in production now (D1)
//
// A case is one way in: a join request, or a direct join (open group, invite link, another
// bot). Policies see only what Kitan saw at that moment, including the model answers it
// actually got, so no model is called. Labels, strongest first:
//   hand   labels.jsonl {"user_id", "account": "spam" | "ham"}, written from `sheet`
//   lols   listed on lols.bot when Kitan asked (an outside list)
//   admin  removed by a human admin afterwards (an ad nobody else caught)
//   ban    banned by Kitan's message rules afterwards (score ≥ 5: several ads)
//   talked replied to someone or was replied to, and none of the above (a person)
// Everything else is unlabelled and not scored. Silent people are under-represented in ham,
// and ads that admins never noticed in spam; the hand labels are there to correct both.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Attempt, type Screening, createStrictChallenge, step } from "../src/attempt";
import type { Decision, ModelVerdict } from "../src/classify";
import { bannedWords } from "../src/lexicon";
import { diversionTargets, strong } from "../src/probation";
import { directDoor, screening } from "../src/screen";

const [command = "score", arg] = process.argv.slice(2);
const dir = process.env.KITAN_BENCH ?? join(process.env.HOME ?? ".", ".cache/kitan-bench/prod");
const read = (name: string): any[] => {
  try {
    return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

type Label = "spam" | "ham";
interface Case {
  id: string;
  door: "request" | "join";
  chat: string;
  user: string;
  at: number;
  name: string;
  username?: string;
  bio?: string;
  channel?: string;
  photo: boolean;
  // What the models answered then; asked: which were asked at all.
  asked: { text: boolean; avatar: boolean };
  decision: Decision | null;
  text: ModelVerdict | null;
  avatar: ModelVerdict | null;
  // Declined before any profile audit (lols.bot, Kitan's blocklist): the same under every
  // policy compared here, so left out of the scores.
  upstream: boolean;
  label: Label | null;
  source: string | null;
}

// ---------- cases ----------

function buildCases(): Case[] {
  const events = read("events.jsonl")
    .map((e) => ({ ...e, detail: JSON.parse(e.detail) }))
    .sort((a, b) => a.at - b.at);
  const by = new Map<string, any[]>();
  for (const e of events) (by.get(e.user_id) ?? by.set(e.user_id, []).get(e.user_id)!).push(e);
  const hand = new Map<string, Label>(read("labels.jsonl").map((l) => [l.user_id, l.account]));
  const attempts = read("attempts.jsonl");
  const lols = new Set(attempts.filter((a) => a.lols === 1).map((a) => a.user_id));
  const upstream = new Set(
    attempts
      .filter((a) => a.status === "declined" && (a.error === "lols_banned" || a.error === "kitan_blocklist"))
      .flatMap((a) => [-1, 0, 1].map((d) => `${a.chat_id}:${a.user_id}:${Math.round(a.created_at / 10_000) + d}`)),
  );
  const mine = (user: string) => by.get(user) ?? [];

  const labelOf = (chat: string, user: string, at: number): [Label | null, string | null] => {
    if (hand.has(user)) return [hand.get(user)!, "hand"];
    if (lols.has(user)) return ["spam", "lols"];
    const after = mine(user).filter((e) => e.at >= at);
    if (after.some((e) => e.kind === "leave" && e.chat_id === chat && e.detail.status === "kicked" && String(e.detail.by).startsWith("user:"))) {
      return ["spam", "admin"];
    }
    if (after.some((e) => e.kind === "action" && e.detail.action === "burn")) return ["spam", "ban"];
    const social = after.some((e) => e.kind === "message" && (e.detail.social?.replies ?? 0) + (e.detail.social?.repliedBy ?? 0) > 0);
    return social ? ["ham", "talked"] : [null, null];
  };
  const profileAt = (user: string, at: number) =>
    mine(user).filter((e) => e.kind === "profile" && e.at <= at + 5_000 && !e.detail.error).at(-1)?.detail ?? null;
  // The verdict Kitan recorded for this case, if any: answers of the models it asked.
  const verdictNear = (user: string, chat: string, at: number, on: string) =>
    mine(user).find((e) => e.kind === "verdict" && e.detail.on === on && e.chat_id === chat && e.at >= at - 1_000 && e.at - at < 60_000)?.detail ?? null;

  const cases: Case[] = [];
  const pushCase = (door: Case["door"], e: any, name: string, username: string | undefined, bio: string | undefined) => {
    const profile = profileAt(e.user_id, e.at);
    const v = verdictNear(e.user_id, e.chat_id, e.at, door === "request" ? "join_request" : "profile");
    const [label, source] = labelOf(e.chat_id, e.user_id, e.at);
    cases.push({
      id: `${door}:${e.chat_id}:${e.user_id}:${e.at}`,
      door,
      chat: e.chat_id,
      user: e.user_id,
      at: e.at,
      name,
      username,
      bio: bio || profile?.bio || undefined,
      channel: profile?.personal_chat ?? undefined,
      photo: profile?.has_photo === true,
      asked: { text: Boolean(v?.decision || v?.text_model), avatar: Boolean(v?.avatar_model) },
      decision: v?.decision ?? null,
      text: v?.text_model ?? null,
      avatar: v?.avatar_model ?? null,
      upstream: door === "request" && upstream.has(`${e.chat_id}:${e.user_id}:${Math.round(e.at / 10_000)}`),
      label,
      source,
    });
  };
  for (const e of events) {
    if (e.kind === "join_request") pushCase("request", e, e.detail.name ?? "", e.detail.username, e.detail.bio);
    // Kitan's own approvals were audited as requests; admins vouch for whom they add.
    else if (e.kind === "join" && !e.detail.by_kitan && !String(e.detail.approved_by ?? "").startsWith("user:")) {
      pushCase("join", e, e.detail.name ?? "", e.detail.username, undefined);
    }
  }
  return cases;
}

// ---------- policies ----------

type Outcome = "turn_away" | "strict" | "ordinary" | "hold" | "allow";
interface Policy {
  name: string;
  decide: (c: Case, turnedAwayBefore: boolean) => Outcome;
}

const lexiconOf = (c: Case) => bannedWords([c.name, c.username, c.bio, c.channel].filter(Boolean).join(" "));
const needsText = (c: Case) => diversionTargets({ name: c.name, bio: c.bio, channel: c.channel }).some(strong);

// Commit 249e6c2, the policy before 2026-11-18: at a request, a listed word or a confident
// model made the check strict, and a model that did not answer in 4 s meant the ordinary
// check; a direct joiner was audited and recorded, never acted on.
const baseline: Policy = {
  name: "baseline 249e6c2",
  decide(c) {
    if (c.door === "join") return "allow";
    const textAd = c.decision !== null && c.decision.p >= 0.9 && c.text !== null && c.text.ad && c.text.confidence >= 0.85;
    const avatarAd = c.avatar !== null && c.avatar.ad && c.avatar.confidence >= 0.9;
    return lexiconOf(c).length > 0 || textAd || avatarAd ? "strict" : "ordinary";
  },
};

// What the code in src/ does now, through its own functions: screening() for the verdict,
// the join state machine for a request, and a hold for any non-clean direct joiner.
// The direct door does not read the avatar.
const current: Policy = {
  name: "current",
  decide(c, turnedAwayBefore) {
    const needText = needsText(c);
    const needAvatar = c.door === "request" && c.photo;
    const verdict: Screening = screening({
      needText,
      needAvatar,
      decision: c.decision,
      text: c.text,
      avatar: needAvatar ? c.avatar : null,
      lexicon: lexiconOf(c).length,
    }).verdict;
    if (c.door === "join") return directDoor(verdict);
    const result = step(screeningAttempt(c), { type: "screened", verdict, repeat: turnedAwayBefore, strict: createStrictChallenge(), at: c.at });
    if (!result.ok) throw new Error(`state machine refused ${c.id}`);
    return result.next.status === "declined" ? "turn_away" : result.next.challenge ? "strict" : "ordinary";
  },
};

function screeningAttempt(c: Case): Attempt {
  return {
    id: 0,
    chatId: c.chat,
    chatTitle: null,
    userId: c.user,
    delivery: { kind: "dm", token: "t", messageId: null },
    createdAt: c.at,
    expiresAt: c.at + 120_000,
    misses: 0,
    challenge: null,
    status: "screening",
  };
}

const POLICIES = [baseline, current];

// Runs a policy over the cases in time order, remembering whom it turned away (a week).
function run(policy: Policy, cases: Case[]): Map<string, Outcome> {
  const away = new Map<string, number>();
  const out = new Map<string, Outcome>();
  for (const c of cases) {
    const key = `${c.chat}:${c.user}`;
    const before = (away.get(key) ?? -Infinity) > c.at - 7 * 86_400_000;
    const o = policy.decide(c, before);
    if (o === "turn_away" || o === "hold") away.set(key, c.at);
    out.set(c.id, o);
  }
  return out;
}

// ---------- statistics ----------

// Wilson score interval, 95%: honest at small n and at rates near 0 or 1.
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// Exact McNemar test on paired outcomes: of the b + c cases where the policies disagree,
// how likely is a split at least this uneven if neither were better? Two-sided.
function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let logC = 0;
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

const pct = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n);
  return n === 0 ? "–" : `${((100 * k) / n).toFixed(1)}% [${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)}] (${k}/${n})`;
};

// ---------- commands ----------

const CASES = "door-cases.jsonl";

if (command === "cases") {
  const cases = buildCases();
  writeFileSync(join(dir, CASES), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  const labelled = cases.filter((c) => c.label);
  console.log(`${cases.length} cases, ${labelled.length} labelled → ${join(dir, CASES)}`);
} else if (command === "score") {
  const cases: Case[] = read(CASES);
  if (cases.length === 0) throw new Error(`no ${CASES}; run: bun bench/door.ts cases`);
  const runs = POLICIES.map((p) => ({ policy: p, out: run(p, cases) }));
  const days = (cases.at(-1)!.at - cases[0].at) / 86_400_000;
  const from = new Date(cases[0].at).toISOString().slice(0, 10);
  const to = new Date(cases.at(-1)!.at).toISOString().slice(0, 10);
  const lines: string[] = [`Cases ${from} – ${to} (${days.toFixed(1)} days). 95% Wilson intervals.`, ""];
  const complete = (c: Case) => !((needsText(c) && !c.asked.text) || (c.door === "request" && c.photo && !c.asked.avatar));
  const subsets: [string, (c: Case) => boolean][] = [
    ["Join requests", (c) => c.door === "request" && !c.upstream],
    ["Join requests, every needed model answer on record", (c) => c.door === "request" && !c.upstream && complete(c)],
    ["Direct joins", (c) => c.door === "join"],
    ["Direct joins, every needed model answer on record", (c) => c.door === "join" && complete(c)],
  ];
  const upstreamCount = cases.filter((c) => c.upstream).length;
  lines.push(`${upstreamCount} requests declined before the audit (lols.bot, blocklist) are left out: every policy here declines them.`, "");
  for (const [title, keep] of subsets) {
    const door = title.startsWith("Join") ? "request" : "join";
    const here = cases.filter(keep);
    const spam = here.filter((c) => c.label === "spam");
    const ham = here.filter((c) => c.label === "ham");
    const sources = (xs: Case[]) => {
      const n = new Map<string, number>();
      for (const c of xs) n.set(c.source!, (n.get(c.source!) ?? 0) + 1);
      return [...n].map(([source, k]) => `${source} ${k}`).join(", ");
    };
    lines.push(`### ${title}: ${here.length} cases; spam ${spam.length} (${sources(spam)}); ham ${ham.length} (${sources(ham)})`, "");
    lines.push("| policy | spam turned away | spam turned away or challenged | ham turned away | ham challenged |", "|---|---|---|---|---|");
    for (const { policy, out } of runs) {
      const count = (xs: Case[], os: Outcome[]) => xs.filter((c) => os.includes(out.get(c.id)!)).length;
      const away: Outcome[] = ["turn_away"];
      const stopped: Outcome[] = ["turn_away", "strict", "hold"];
      const challenged: Outcome[] = ["strict", "hold"];
      lines.push(
        `| ${policy.name} | ${pct(count(spam, away), spam.length)} | ${pct(count(spam, stopped), spam.length)} | ${pct(count(ham, away), ham.length)} | ${pct(count(ham, challenged), ham.length)} |`,
      );
    }
    // Paired: of the spam where the two policies differ, which one stops more?
    const [a, b] = runs;
    const stops = (o: Outcome) => o === "turn_away" || o === "strict" || o === "hold";
    const onlyB = spam.filter((c) => stops(b.out.get(c.id)!) && !stops(a.out.get(c.id)!)).length;
    const onlyA = spam.filter((c) => stops(a.out.get(c.id)!) && !stops(b.out.get(c.id)!)).length;
    const missing = here.filter((c) => !complete(c)).length;
    lines.push(
      "",
      `Spam stopped only by ${b.policy.name}: ${onlyB}; only by ${a.policy.name}: ${onlyA}; exact McNemar p = ${mcnemar(onlyA, onlyB).toPrecision(2)}.`,
      missing > 0
        ? `${missing} of these cases needed a model that was not asked or did not answer then; the current policy counts them as suspect, so its challenge rates are upper bounds.`
        : "",
      "",
    );
    void door;
  }
  console.log(lines.join("\n"));
} else if (command === "sheet") {
  const cases: Case[] = read(CASES);
  const n = Number(arg ?? 100);
  const pool = cases.filter((c) => !c.label);
  // Shuffle with a fixed seed so the same export gives the same sheet.
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const picked = pool.map((c) => [rand(), c] as const).sort((x, y) => x[0] - y[0]).slice(0, n).map(([, c]) => c);
  const outcome = run(current, cases);
  const sheet = picked.map(
    (c) => `## ${c.user} (${c.door}, current: ${outcome.get(c.id)})\nname: ${c.name}\nusername: ${c.username ?? ""}\nbio: ${c.bio ?? ""}\nchannel: ${c.channel ?? ""}\n`,
  );
  writeFileSync(join(dir, "door-sheet.md"), sheet.join("\n"));
  console.log(`${picked.length} unlabelled cases → ${join(dir, "door-sheet.md")}; add lines to labels.jsonl`);
} else if (command === "live") {
  // Aggregates only: what the doors decided lately, how often a needed model did not answer
  // (the cost the offline score cannot see), and what people did with the strict check.
  const since = Date.now() - Number(arg ?? 24) * 3_600_000;
  const d1 = (sql: string): Record<string, unknown>[] =>
    JSON.parse(
      execFileSync("bunx", ["wrangler", "d1", "execute", "kitan", "--remote", "--json", "--command", sql], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    )[0].results;
  const report: [string, string][] = [
    [
      "Join requests by verdict and outcome",
      `SELECT json_extract(detail,'$.verdict') AS verdict, json_extract(detail,'$.outcome') AS outcome, json_extract(detail,'$.missing') AS missing, count(*) AS n
       FROM events WHERE kind='verdict' AND json_extract(detail,'$.on')='join_request' AND at > ${since} AND json_extract(detail,'$.verdict') IS NOT NULL GROUP BY 1,2,3 ORDER BY n DESC`,
    ],
    [
      "Direct joins by verdict and action",
      `SELECT json_extract(detail,'$.verdict') AS verdict, json_extract(detail,'$.action') AS action, json_extract(detail,'$.missing') AS missing, count(*) AS n
       FROM events WHERE kind='verdict' AND json_extract(detail,'$.on')='profile' AND at > ${since} AND json_extract(detail,'$.verdict') IS NOT NULL GROUP BY 1,2,3 ORDER BY n DESC`,
    ],
    [
      "Holds: passed in time, removed, still waiting",
      `SELECT sum(passed_at IS NOT NULL) AS passed, sum(kicked_at IS NOT NULL) AS removed, sum(passed_at IS NULL AND kicked_at IS NULL) AS waiting, count(*) AS n
       FROM appeals WHERE kick_at IS NOT NULL AND created_at > ${since}`,
    ],
    [
      "Strict checks at the door: passed, lapsed, other",
      `SELECT status, count(*) AS n FROM attempts WHERE challenge IS NOT NULL AND created_at > ${since} GROUP BY 1`,
    ],
    [
      "Ad declines, and how many asked again within the window",
      `SELECT count(DISTINCT d.chat_id || d.user_id) AS declined,
              count(DISTINCT CASE WHEN r.id IS NOT NULL THEN d.chat_id || d.user_id END) AS asked_again,
              count(DISTINCT CASE WHEN r.status = 'approved' THEN d.chat_id || d.user_id END) AS then_passed
       FROM attempts d LEFT JOIN attempts r ON r.chat_id = d.chat_id AND r.user_id = d.user_id AND r.created_at > d.created_at
       WHERE d.status = 'declined' AND d.error = 'ad_profile' AND d.created_at > ${since}`,
    ],
  ];
  for (const [title, sql] of report) {
    console.log(`\n${title}`);
    console.table(d1(sql));
  }
  console.log("\nPeople who passed a strict check after being flagged are the false-positive candidates: label them in labels.jsonl.");
} else {
  console.error("usage: bun bench/door.ts cases|score|sheet [n]|live [hours]");
  process.exit(1);
}
