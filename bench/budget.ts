// Bench runs share the production Worker's Workers AI allowance (10,000 neurons over a
// rolling day on the free plan). On 2026-11-12 they spent half of it and production's
// model calls failed the next morning. So a run first checks what is left, and afterwards
// books what it spent where production's budget (src/moderation.ts) counts it.
import { execFileSync } from "node:child_process";

const ALLOWANCE = 10_000;
const KEEP_FOR_PRODUCTION = 3_000;

export async function checkHeadroom(account: string, token: string, need: number): Promise<void> {
  const now = new Date();
  const query = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
    aiInferenceAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_lt:$e}){sum{totalNeurons}}}}}`;
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { a: account, s: new Date(now.getTime() - 24 * 3_600_000).toISOString(), e: now.toISOString() },
    }),
  });
  const body = (await response.json()) as {
    data?: { viewer: { accounts: { aiInferenceAdaptiveGroups: { sum: { totalNeurons: number } }[] }[] } };
    errors?: unknown;
  };
  if (!body.data) throw new Error(`Cannot read Workers AI usage: ${JSON.stringify(body.errors)}`);
  const used = body.data.viewer.accounts[0]?.aiInferenceAdaptiveGroups.reduce((s, g) => s + g.sum.totalNeurons, 0) ?? 0;
  const left = ALLOWANCE - used - KEEP_FOR_PRODUCTION;
  console.log(`Workers AI, last 24 h: ${Math.round(used)} neurons used; this run may need ${need}, ${Math.round(left)} available.`);
  if (need > left) {
    throw new Error("Not enough allowance left without starving production; run later or with fewer cases.");
  }
}

export function bookSpend(neurons: number): void {
  if (neurons <= 0) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  const sql = `INSERT INTO spend (hour, neurons) VALUES (${hour}, ${Math.ceil(neurons)})
    ON CONFLICT (hour) DO UPDATE SET neurons = neurons + excluded.neurons`;
  execFileSync("bunx", ["wrangler", "d1", "execute", "kitan", "--remote", "--command", sql], { stdio: "ignore" });
}
