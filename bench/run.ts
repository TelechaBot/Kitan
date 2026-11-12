// Scores Kitan's detectors on labelled cases, using the production code and the real
// Workers AI models (over the REST API, so it runs outside the Worker).
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=$(bunx wrangler auth token) bun bench/run.ts [cases.jsonl]
//
// Two questions, scored separately, because spam accounts often open with a message
// that is harmless on its own:
//   message: does this message itself carry an ad?      (label field "message": ad | benign)
//   account: does this message come from a spam account? (label field "account": spam | ham)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Dossier, type ModelVerdict, decideText, forModels, judgeText } from "../src/classify";
import { chatWords, profileWords } from "../src/lexicon";
import { spamReason } from "../src/probation";
import type { Env, Message } from "../src/types";

interface Case {
  id: string;
  account: "spam" | "ham";
  message: "ad" | "benign";
  kind: string;
  source: string;
  name: string;
  approved_by?: string;
  bio?: string;
  personal_chat?: string;
  index: number;
  edited?: boolean;
  text: string;
}

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  process.exit(2);
}

// The Worker's AI binding, backed by the REST API; `spent` sums the neurons Cloudflare bills.
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

// Models are not deterministic and calls sometimes fail, so each case is asked `--repeat`
// times (default 3); the model counts as flagging a case when most successful answers do.
// Failed calls are reported apart, never counted as a miss.
const args = process.argv.slice(2);
const repeatAt = args.indexOf("--repeat");
const repeat = repeatAt >= 0 ? Number(args[repeatAt + 1]) : 3;
const file =
  args.find((a: string, i: number) => !a.startsWith("--") && args[i - 1] !== "--repeat") ?? join(import.meta.dir, "cases.jsonl");
const cases: Case[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

type Detector = "rules" | "lexicon" | "model≥0.5" | "model≥0.8" | "decision≥0.3" | "decision≥0.5";
const DETECTORS: Detector[] = ["rules", "lexicon", "model≥0.5", "model≥0.8", "decision≥0.3", "decision≥0.5"];
const rows: {
  c: Case;
  hits: Record<Detector, boolean>;
  model: ModelVerdict | null;
  words: string[];
  agree: string;
  p: string;
}[] = [];
const neurons = { model: 0, decision: 0 };
let failures = 0;

for (const c of cases) {
  const message = { message_id: 1, chat: { id: -1 }, text: c.text } as Message;
  const words = [...chatWords(c.text), ...profileWords(c.name)];
  // What production shows the models.
  const subject: Dossier = forModels({ name: c.name, bio: c.bio, personalChat: c.personal_chat, kind: "text", edited: c.edited ?? false, text: c.text });
  const answers: ModelVerdict[] = [];
  const decisions: number[] = [];
  for (let i = 0; i < repeat; i++) {
    let before = spent;
    const verdict = await judgeText(env, subject);
    neurons.model += spent - before;
    if (verdict) answers.push(verdict);
    else failures += 1;
    before = spent;
    const decision = await decideText(env, subject);
    neurons.decision += spent - before;
    if (decision) decisions.push(decision.p);
    else failures += 1;
  }
  const majority = (threshold: number) =>
    answers.filter((a) => a.ad && a.confidence >= threshold).length * 2 > answers.length;
  const decided = (threshold: number) => decisions.filter((p) => p >= threshold).length * 2 > decisions.length;
  rows.push({
    c,
    model: answers[0] ?? null,
    words,
    agree: `${answers.filter((a) => a.ad).length}/${answers.length}`,
    p: decisions.map((p) => p.toFixed(2)).join(" "),
    hits: {
      rules: spamReason(message) !== null,
      lexicon: words.length > 0,
      "model≥0.5": majority(0.5),
      "model≥0.8": majority(0.8),
      "decision≥0.3": decided(0.3),
      "decision≥0.5": decided(0.5),
    },
  });
}

console.log("\nPer case");
console.table(
  rows.map(({ c, hits, model, words, agree }) => ({
    id: c.id,
    truth: `${c.account}/${c.message}`,
    rules: hits.rules ? "✔" : "",
    lexicon: words.join(",").slice(0, 20),
    "model says ad": agree,
    first: model ? `${model.confidence} ${model.kind}` : "error",
    "decision P(ad)": rows.find((r) => r.c === c)?.p ?? "",
    why: (model?.reason ?? "").slice(0, 40),
  })),
);

for (const level of ["message", "account"] as const) {
  const positive = (c: Case) => (level === "message" ? c.message === "ad" : c.account === "spam");
  console.log(`\n${level}-level (positives: ${rows.filter((r) => positive(r.c)).length}, negatives: ${rows.filter((r) => !positive(r.c)).length})`);
  console.table(
    DETECTORS.map((d) => {
      const tp = rows.filter((r) => r.hits[d] && positive(r.c)).length;
      const fp = rows.filter((r) => r.hits[d] && !positive(r.c)).length;
      const fn = rows.filter((r) => !r.hits[d] && positive(r.c)).length;
      const tn = rows.filter((r) => !r.hits[d] && !positive(r.c)).length;
      const ratio = (a: number, b: number) => (b ? (a / b).toFixed(2) : "-");
      return { detector: d, tp, fp, fn, tn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), false_positive_rate: ratio(fp, fp + tn) };
    }),
  );
}
const ms = rows.map((r) => r.model?.ms ?? 0).filter(Boolean).sort((a, b) => a - b);
console.log(`\nmodel: ${repeat} asks per case; latency median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms.at(-1)} ms; failed calls ${failures}`);
const asks = cases.length * repeat;
console.log(
  `neurons per message: written verdict ${(neurons.model / asks).toFixed(2)}, decision ${(neurons.decision / asks).toFixed(2)}`,
);
