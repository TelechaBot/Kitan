// Compares text models on production cases, for when Workers AI retires the one in use.
// Each candidate answers the production prompts (decideText, judgeText) on what production
// showed the model; the old model's recorded answers are the reference.
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=$(bunx wrangler auth token) bun bench/models.ts [per-set]
//
// Sets, from the export in ~/.cache/kitan-bench/prod (bench/replay.ts export, door.ts cases):
//   seed     bench/cases.jsonl: covert ads and hard negatives, labelled by hand
//   profile  join-door profiles that point somewhere, labelled as in door.ts, plus unlabelled
//            ones the old model answered (agreement)
//   message  newcomer messages the old model answered, labelled by the sender's account
// Answers are cached per model and prompt, so a rerun only pays for new cases.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Decision, type Dossier, type ModelVerdict, type TextModel, PROMPTS, decideText, forModels, judgeText } from "../src/classify";
import { diversionTargets, strong } from "../src/probation";
import type { Env } from "../src/types";
import { checkHeadroom } from "./budget";

const CANDIDATES: TextModel[] = [
  { id: "@cf/google/gemma-4-26b-a4b-it", options: { chat_template_kwargs: { enable_thinking: false } } },
];
// Tried on 2026-11-21 and left out: granite-4.0-h-micro (a quarter of gemma's cost, missed
// bare invite links with money offers); llama-3.3-70b and mistral-small-3.1 (3× qwen's cost);
// gpt-oss, glm-4.7 and qwen3.8 answer with reasoning first, so no yes/no token to read.
const TIMEOUT_MS = 20_000; // production's limit (screen.ts)
const perSet = Number(process.argv[2] ?? 60);

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  process.exit(2);
}
const dir = process.env.KITAN_BENCH ?? join(process.env.HOME ?? ".", ".cache/kitan-bench/prod");
const read = (path: string): any[] => {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

type Label = "spam" | "ham" | null;
interface Case {
  set: "seed" | "profile" | "message";
  label: Label;
  view: Dossier;
  old: boolean | null; // the old model's production verdict, when recorded
}

// Production's rule for a confident text verdict (screen.ts, moderation.ts).
const confident = (d: Decision | null, v: ModelVerdict | null) =>
  d !== null && v !== null && d.p >= 0.9 && v.ad && v.confidence >= 0.85;

// A fixed shuffle, so every model and every rerun sees the same cases.
function sample<T>(xs: T[], n: number, seed = 7): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function buildCases(): Case[] {
  const seed: Case[] = read(join(import.meta.dir, "cases.jsonl")).map((c) => ({
    set: "seed",
    label: c.account,
    old: null,
    view: forModels({ name: c.name, bio: c.bio, personalChat: c.personal_chat, kind: "text", edited: c.edited ?? false, text: c.text }),
  }));

  const door = read(join(dir, "door-cases.jsonl"));
  const labels = new Map<string, Label>(door.filter((c) => c.label).map((c) => [c.user, c.label]));
  for (const l of read(join(dir, "labels.jsonl"))) labels.set(l.user_id, l.account);

  const profiles = new Map<string, Case>();
  for (const c of door) {
    if (c.upstream || !diversionTargets({ name: c.name, bio: c.bio, channel: c.channel }).some(strong)) continue;
    const view = forModels({ name: c.name, username: c.username, bio: c.bio, personalChat: c.channel, kind: "none", edited: false, text: "(they are asking to join and have not posted yet)" });
    profiles.set(JSON.stringify(view), { set: "profile", label: labels.get(c.user) ?? null, view, old: c.decision && c.text ? confident(c.decision, c.text) : null });
  }
  const p = [...profiles.values()];

  const messages = new Map<string, Case>();
  for (const e of read(join(dir, "events.jsonl"))) {
    if (e.kind !== "verdict") continue;
    const d = JSON.parse(e.detail);
    if ((d.on !== "message" && d.on !== "edit") || !d.dossier || !d.decision || !d.text_model) continue;
    const view = forModels(d.dossier);
    messages.set(JSON.stringify(view), { set: "message", label: labels.get(e.user_id) ?? null, view, old: confident(d.decision, d.text_model) });
  }
  const m = [...messages.values()];

  const pick = (xs: Case[]) => [
    ...xs.filter((c) => c.label === "ham"),
    ...sample(xs.filter((c) => c.label === "spam"), perSet),
    // Unlabelled: as many the old model passed as it flagged, since false positives are the risk.
    ...sample(xs.filter((c) => c.label === null && c.old === true), perSet),
    ...sample(xs.filter((c) => c.label === null && c.old === false), perSet),
  ];
  return [...seed, ...pick(p), ...pick(m)];
}

// One binding per call, so concurrent calls count their own neurons.
let spent = 0;
const counting = (into: { n: number }) => ({
  AI: {
    async run(model: string, input: unknown) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json()) as { success: boolean; result: { usage?: { neurons?: number } }; errors?: unknown };
      if (!body.success) throw new Error(JSON.stringify(body.errors));
      into.n += body.result?.usage?.neurons ?? 0;
      spent += body.result?.usage?.neurons ?? 0;
      return body.result;
    },
  },
}) as unknown as Env;

interface Answer {
  key: string;
  decision: Decision | null;
  verdict: ModelVerdict | null;
  neurons: { decision: number; verdict: number };
}

const cases = buildCases();
const cachePath = join(dir, "models-cache.jsonl");
const cache = new Map<string, Answer>(read(cachePath).map((a) => [a.key, a]));
const keyOf = (m: TextModel, c: Case) => `${m.id} ${Bun.hash(JSON.stringify([PROMPTS, m.options ?? null])).toString(36)} ${JSON.stringify(c.view)}`;
const todo = CANDIDATES.flatMap((m) => cases.filter((c) => !cache.has(keyOf(m, c))).map((c) => ({ m, c })));
console.log(`${cases.length} cases × ${CANDIDATES.length} models; ${todo.length} answers to fetch`);
if (todo.length) await checkHeadroom(account, token, todo.length * 6);

for (let i = 0; i < todo.length; i += 4) {
  await Promise.all(
    todo.slice(i, i + 4).map(async ({ m, c }) => {
      const d = { n: 0 };
      const v = { n: 0 };
      const [decision, verdict] = await Promise.all([decideText(counting(d), c.view, m), judgeText(counting(v), c.view, m)]);
      const answer = { key: keyOf(m, c), decision, verdict, neurons: { decision: d.n, verdict: v.n } };
      cache.set(answer.key, answer);
    }),
  );
  writeFileSync(cachePath, [...cache.values()].map((a) => JSON.stringify(a)).join("\n") + "\n");
}
console.log(`Spent this run: ${Math.round(spent)} neurons (not booked in production's spend table)\n`);

// Detectors: each candidate as production uses it, and its decision alone.
const answer = (m: TextModel, c: Case) => cache.get(keyOf(m, c))!;
const detectors: Record<string, (c: Case) => boolean | null> = {};
for (const m of CANDIDATES) {
  const name = m.id.split("/").pop()!.split("-").slice(0, 2).join("-");
  detectors[`${name} decision≥0.9 + verdict≥0.85`] = (c) => {
    const a = answer(m, c);
    return a.decision && a.verdict ? confident(a.decision, a.verdict) : null;
  };
  detectors[`${name} decision≥0.9 alone`] = (c) => (answer(m, c).decision ? answer(m, c).decision!.p >= 0.9 : null);
}
detectors["old model (recorded)"] = (c) => c.old;

const pct = (a: number, b: number) => (b ? `${a}/${b}` : "-");
for (const set of ["seed", "profile", "message"] as const) {
  const here = cases.filter((c) => c.set === set);
  const table: Record<string, Record<string, string>> = {};
  for (const [name, flag] of Object.entries(detectors)) {
    const rows = here.map((c) => ({ c, f: flag(c) }));
    const answered = rows.filter((r) => r.f !== null);
    const spam = answered.filter((r) => r.c.label === "spam");
    const ham = answered.filter((r) => r.c.label === "ham");
    const withOld = answered.filter((r) => r.c.old !== null);
    table[name] = {
      "spam caught": pct(spam.filter((r) => r.f).length, spam.length),
      "ham flagged": pct(ham.filter((r) => r.f).length, ham.length),
      "agrees with old": pct(withOld.filter((r) => r.f === r.c.old).length, withOld.length),
      "old ad, missed": pct(withOld.filter((r) => r.c.old && !r.f).length, withOld.filter((r) => r.c.old).length),
      "old clean, flagged": pct(withOld.filter((r) => !r.c.old && r.f).length, withOld.filter((r) => !r.c.old).length),
      "no answer": pct(rows.length - answered.length, rows.length),
    };
  }
  console.log(`${set}: ${here.length} cases (spam ${here.filter((c) => c.label === "spam").length}, ham ${here.filter((c) => c.label === "ham").length}, unlabelled ${here.filter((c) => c.label === null).length})`);
  console.table(table);
}

for (const m of CANDIDATES) {
  const as = cases.map((c) => answer(m, c));
  const ms = as.flatMap((a) => [a.decision?.ms, a.verdict?.ms]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  const mean = (f: (a: Answer) => number) => (as.reduce((s, a) => s + f(a), 0) / as.length).toFixed(2);
  console.log(
    `${m.id}: neurons per case decision ${mean((a) => a.neurons.decision)}, verdict ${mean((a) => a.neurons.verdict)}; ` +
      `latency p50 ${ms[Math.floor(ms.length / 2)]} ms, p95 ${ms[Math.floor(ms.length * 0.95)]} ms; ` +
      `failed decision ${as.filter((a) => !a.decision).length}, verdict ${as.filter((a) => !a.verdict).length} of ${as.length}`,
  );
}
// Thresholds: what each candidate would flag at stricter cut-offs, over all sets.
// "people": labelled ham plus cases the old model passed (it had no measured false positive).
console.log("\nThreshold sweep (all sets): spam caught | people flagged");
const sweep: Record<string, Record<string, string>> = {};
for (const m of CANDIDATES) {
  for (const dp of [0.9, 0.99, 0.999]) {
    const row: Record<string, string> = {};
    for (const vc of [0, 0.85, 0.95]) {
      const flag = (c: Case) => {
        const a = answer(m, c);
        return a.decision !== null && a.decision.p >= dp && (vc === 0 || (a.verdict !== null && a.verdict.ad && a.verdict.confidence >= vc));
      };
      const spam = cases.filter((c) => c.label === "spam");
      const people = cases.filter((c) => c.label === "ham" || (c.label === null && c.old === false));
      row[vc === 0 ? "decision only" : `+ verdict≥${vc}`] = `${spam.filter(flag).length}/${spam.length} | ${people.filter(flag).length}/${people.length}`;
    }
    sweep[`${m.id.split("/").pop()} p≥${dp}`] = row;
  }
}
console.table(sweep);

const flaggedHam = cases.filter((c) => c.label === "ham" && Object.entries(detectors).some(([n, f]) => !n.startsWith("old") && f(c)));
if (flaggedHam.length) {
  console.log("\nHam flagged by a candidate:");
  for (const c of flaggedHam) console.log(`  [${c.set}] ${JSON.stringify(c.view).slice(0, 200)}`);
}
