// Replays production footprints against the real models, to measure on real people what
// bench/run.ts measures on a seed set. The data stays outside the repo: it is real
// people's messages. Export it, label accounts by hand, then replay:
//
//   bun bench/replay.ts export ~/.cache/kitan-bench/prod      # D1 tables → jsonl
//   bun bench/replay.ts sheet  ~/.cache/kitan-bench/prod      # one block per account, to label
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… bun bench/replay.ts run ~/.cache/kitan-bench/prod
//
// labels.jsonl: {"user_id": "…", "account": "spam" | "ham", "note": "…"}; accounts left
// out are not scored. A false positive is a ham account the detector would flag at least
// once: that is what a person would suffer if the detector acted.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Dossier, NEURONS, PROMPTS, decideText, forModels, judgeText } from "../src/classify";
import { bookSpend, checkHeadroom } from "./budget";
import { diversionTargets } from "../src/probation";
import { accountYears } from "../src/trajectory";
import type { Env } from "../src/types";

const [command, dir = join(process.env.HOME ?? ".", ".cache/kitan-bench/prod")] = process.argv.slice(2);
const read = (name: string) => {
  try {
    return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

interface Event {
  at: number;
  chat_id: string;
  user_id: string;
  kind: string;
  detail: Record<string, any>;
}

interface Account {
  userId: string;
  joins: Event[];
  profiles: Event[];
  messages: Event[];
  verdicts: Event[];
  leaves: Event[];
}

function accounts(): Map<string, Account> {
  const events: Event[] = read("events.jsonl").map((e: any) => ({ ...e, detail: JSON.parse(e.detail) }));
  const all = new Map<string, Account>();
  for (const e of events.sort((a, b) => a.at - b.at)) {
    const a = all.get(e.user_id) ?? { userId: e.user_id, joins: [], profiles: [], messages: [], verdicts: [], leaves: [] };
    all.set(e.user_id, a);
    if (e.kind === "join") a.joins.push(e);
    else if (e.kind === "profile") a.profiles.push(e);
    else if (e.kind === "message" || e.kind === "edit") a.messages.push(e);
    else if (e.kind === "verdict") a.verdicts.push(e);
    else if (e.kind === "leave") a.leaves.push(e);
  }
  return all;
}

const titles = new Map<string, string>(read("chats.jsonl").map((c: any) => [c.chat_id, c.title]));

function textOf(m: Event): string {
  const f = m.detail.facts ?? {};
  return f.text ?? f.caption ?? "";
}

function kindOf(m: Event): string {
  const f = m.detail.facts ?? {};
  return f.kind ?? (f.text ? "text" : f.photo ? "photo" : "unknown");
}

// What the models would have been shown for this message: the recorded dossier when the
// footprint has one, otherwise rebuilt from the footprints around it.
function dossierFor(a: Account, m: Event): Dossier {
  const recorded = a.verdicts.find((v) => v.chat_id === m.chat_id && v.at >= m.at && v.at - m.at < 60_000 && v.detail.dossier);
  if (recorded) return recorded.detail.dossier;
  const join = [...a.joins].reverse().find((j) => j.chat_id === m.chat_id && j.at <= m.at)?.detail;
  const profile = [...a.profiles].reverse().find((p) => p.at <= m.at + 60_000 && !p.detail.error)?.detail;
  const admittedBy = !join
    ? undefined
    : join.by_kitan || /SmartVerifyBot/.test(join.approved_by ?? "")
      ? "Kitan's check (a captcha)"
      : join.invite_link
        ? `invite link "${join.invite_link}"${join.invite_link_creator ? ` made by ${join.invite_link_creator}` : ""}`
        : (join.approved_by ?? "themselves (open group)");
  return {
    group: titles.get(m.chat_id),
    name: m.detail.name ?? join?.name ?? "",
    username: m.detail.username,
    bio: profile?.bio ?? undefined,
    personalChat: profile?.personal_chat ?? undefined,
    accountYears: Math.round(accountYears(Number(a.userId), m.at) * 10) / 10,
    admittedBy,
    minutesSinceJoin: m.detail.minutes_since_join ?? null,
    messages: m.detail.messages,
    groups: 1,
    kind: kindOf(m),
    edited: m.kind === "edit",
    text: textOf(m),
  };
}

// The views compared: what each field adds, and what it costs in false positives.
const VIEWS: Record<string, (d: Dossier) => Dossier> = {
  message: (d) => ({ name: d.name, kind: d.kind, edited: d.edited, text: d.text }),
  profile: forModels, // what production shows

  dossier: (d) => d,
};

// The deterministic guard: does the sender point anywhere (production's targetsOf)?
function hasTarget(d: Dossier): boolean {
  const card = d.kind === "contact" || d.text.startsWith("[contact card");
  return (
    diversionTargets({
      message: card ? undefined : d.text,
      name: d.name,
      bio: d.bio,
      channel: d.personalChat,
      contact: card ? d.text : undefined,
    }).length > 0
  );
}

// At most this many distinct messages per account: one flooder must not stand for many people.
const PER_ACCOUNT = 4;

function samples(a: Account): Event[] {
  const seen = new Set<string>();
  return a.messages.filter((m) => {
    const key = `${kindOf(m)}:${textOf(m)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, PER_ACCOUNT);
}

// ---------- commands ----------

if (command === "export") {
  for (const table of ["events", "chats", "speakers", "trajectories", "offenses", "profiles"]) {
    const out = execFileSync("bunx", ["wrangler", "d1", "execute", "kitan", "--remote", "--json", "--command", `SELECT * FROM ${table}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 28,
    });
    const rows = JSON.parse(out)[0].results as unknown[];
    writeFileSync(join(dir, `${table}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`${table}: ${rows.length}`);
  }
} else if (command === "sheet") {
  for (const a of accounts().values()) {
    if (!a.messages.length && !a.joins.length) continue;
    const join = a.joins[0]?.detail;
    const profile = a.profiles.find((p) => !p.detail.error)?.detail;
    const leaves = a.leaves.map((l) => `${l.detail.status} by ${l.detail.by}`).join(", ");
    console.log(
      [
        `## ${a.userId}  ${titles.get(a.messages[0]?.chat_id ?? a.joins[0]?.chat_id) ?? ""}`,
        `name: ${a.messages[0]?.detail.name ?? join?.name ?? ""}  @${a.messages[0]?.detail.username ?? join?.username ?? ""}`,
        `in: ${join ? (join.approved_by ?? "self") + (join.invite_link ? ` via "${join.invite_link}"` : "") : "-"}  out: ${leaves || "-"}`,
        `bio: ${(profile?.bio ?? "-").replace(/\n/g, " ")}  channel: ${profile?.personal_chat ?? "-"}`,
        `messages (${a.messages.length}): ${samples(a).map((m) => `[${kindOf(m)}] ${textOf(m).replace(/\n/g, " ").slice(0, 80)}`).join(" | ") || "-"}`,
      ].join("\n"),
    );
  }
} else if (command === "run") {
  await replay();
} else {
  console.error("usage: bun bench/replay.ts export|sheet|run [dir]");
  process.exit(2);
}

async function replay() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  let spent = 0;
  const env = {
    AI: {
      async run(model: string, input: unknown) {
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        const body = (await response.json()) as { success: boolean; result: { usage?: { neurons?: number } }; errors?: unknown };
        if (!body.success) throw new Error(JSON.stringify(body.errors));
        spent += body.result?.usage?.neurons ?? 0;
        return body.result;
      },
    },
  } as unknown as Env;

  const labels = new Map<string, { account: "spam" | "ham"; note?: string }>(read("labels.jsonl").map((l: any) => [l.user_id, l]));
  const all = accounts();
  const thresholds = { "decide≥0.5": 0.5, "decide≥0.8": 0.8, "decide≥0.95": 0.95 } as const;
  type Row = { userId: string; label: "spam" | "ham"; view: string; text: string; p: number | null; judged: boolean | null; target: boolean };
  const rows: Row[] = [];
  const cache = join(dir, "replay-cache.jsonl");
  const cached = new Map<string, { p: number | null; judged: boolean | null }>(read("replay-cache.jsonl").map((r: any) => [r.key, r]));

  const jobs: (() => Promise<void>)[] = [];
  for (const [userId, label] of labels) {
    const a = all.get(userId);
    if (!a) continue;
    // Someone who only joined is judged on the profile alone, as at join.
    const cases: Dossier[] = a.messages.length
      ? samples(a).map((m) => dossierFor(a, m))
      : a.joins.length
        ? [{ ...dossierFor(a, { ...a.joins[0], kind: "message", detail: { name: a.joins[0].detail.name, username: a.joins[0].detail.username, minutes_since_join: 0, facts: {} } }), kind: "none", text: "(they have just joined and not posted yet)" }]
        : [];
    for (const d of cases) {
      for (const [view, shape] of Object.entries(VIEWS)) {
        const shown = shape(d);
        const key = `${Bun.hash(JSON.stringify(PROMPTS)).toString(36)} ${JSON.stringify(shown)}`;
        jobs.push(async () => {
          let hit = cached.get(key);
          if (!hit) {
            const [decision, verdict] = await Promise.all([decideText(env, shown), judgeText(env, shown)]);
            hit = { p: decision?.p ?? null, judged: verdict ? verdict.ad && verdict.confidence >= 0.5 : null };
            cached.set(key, hit);
            writeFileSync(cache, [...cached].map(([k, v]) => JSON.stringify({ key: k, ...v })).join("\n") + "\n");
          }
          rows.push({ userId, label: label.account, view, text: d.text.slice(0, 40), ...hit, target: hasTarget(d) });
        });
      }
    }
  }
  // Cached answers cost nothing; this bounds the rest from above.
  await checkHeadroom(account, token, jobs.length * (NEURONS.verdict + NEURONS.decision));
  for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map((j) => j()));
  bookSpend(spent);

  // Account-level: flagged if any of its messages is.
  console.log(`\nAccounts labelled: ${labels.size}; model calls this run: ${Math.round(spent)} neurons\n`);
  const table: Record<string, Record<string, string>> = {};
  for (const view of Object.keys(VIEWS)) {
    const detectors: Record<string, (r: Row) => boolean | null> = {
      ...Object.fromEntries(Object.entries(thresholds).map(([name, t]) => [name, (r: Row) => (r.p === null ? null : r.p >= t)])),
      verdict: (r: Row) => r.judged,
      // The guard alone, and each model only where the sender points somewhere.
      "target only": (r: Row) => r.target,
      "decide≥0.8 + target": (r: Row) => (r.p === null ? null : r.p >= 0.8 && r.target),
      "verdict + target": (r: Row) => (r.judged === null ? null : r.judged && r.target),
    };
    for (const [name, flag] of Object.entries(detectors)) {
      const byAccount = new Map<string, { label: string; flagged: boolean }>();
      let msgFp = 0;
      let msgHam = 0;
      for (const r of rows.filter((x) => x.view === view)) {
        const f = flag(r);
        if (f === null) continue;
        const acc = byAccount.get(r.userId) ?? { label: r.label, flagged: false };
        acc.flagged ||= f;
        byAccount.set(r.userId, acc);
        if (r.label === "ham") {
          msgHam++;
          if (f) msgFp++;
        }
      }
      const accs = [...byAccount.values()];
      const spam = accs.filter((x) => x.label === "spam");
      const ham = accs.filter((x) => x.label === "ham");
      const tp = spam.filter((x) => x.flagged).length;
      const fp = ham.filter((x) => x.flagged).length;
      table[`${view} ${name}`] = {
        recall: `${tp}/${spam.length}`,
        "FP accounts": `${fp}/${ham.length}`,
        "FP messages": `${msgFp}/${msgHam}`,
        precision: tp + fp ? (tp / (tp + fp)).toFixed(2) : "-",
      };
    }
  }
  console.table(table);
  // Per account: the highest P(ad) and whether any written verdict said ad, per view.
  const per: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    const key = `${r.label} ${r.userId}`;
    per[key] ??= { note: (labels.get(r.userId)?.note ?? "").slice(0, 16) };
    const was = per[key][r.view];
    const p = r.p === null ? -1 : r.p;
    const [best, judged] = was ? [Number(was.split(" ")[0]), was.endsWith("✔")] : [-1, false];
    per[key][r.view] = `${Math.max(best, p).toFixed(2)} ${judged || r.judged ? "✔" : "·"}`;
  }
  console.table(Object.fromEntries(Object.entries(per).sort()));
  const fps = rows.filter((r) => r.label === "ham" && r.p !== null && r.p >= 0.5);
  if (fps.length) {
    console.log("\nHam flagged at p ≥ 0.5 (view, user, p, text):");
    for (const r of fps) console.log(`  ${r.view.padEnd(8)} ${r.userId.padEnd(11)} ${r.p!.toFixed(3)}  ${r.text}`);
  }
}
