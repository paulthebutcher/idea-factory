// Estimates the cost of a full live run per stage from recorded per-sample costs, and recommends
// RUN_BUDGET_USD. Kill gate numbers come from the recorded transcripts (model) and recording logs
// (search). Viability and critic numbers come from recorded fixtures when present, otherwise from
// stated token assumptions. Prints the assumptions with the result.
//
//   npm run estimate [-- --headroom 0.25]
import fs from "node:fs";
import path from "node:path";
import { PATHS, PRICING, MODELS } from "../src/config.js";
import { openDb } from "../src/store/db.js";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

interface StageSample { model: number; search: number; calls: number }

/** Per-transcript model cost plus the share of search cost recorded alongside it. */
function recordedSamples(stage: string, dir = PATHS.fixtures): StageSample[] {
  const mdir = path.join(dir, "model", stage);
  if (!fs.existsSync(mdir)) return [];
  const out: StageSample[] = [];
  for (const f of fs.readdirSync(mdir).filter((f) => f.endsWith(".json"))) {
    const t = JSON.parse(fs.readFileSync(path.join(mdir, f), "utf8"));
    if (!Array.isArray(t.calls)) continue; // briefs.json and other non-transcript files
    const model = t.calls.reduce((a: number, c: any) => a + (c.cost_usd ?? 0), 0);
    // Search spend per sample: count tool calls in the transcript and price them at the recorded average.
    let searches = 0;
    for (const c of t.calls) for (const b of c.response.content ?? []) if (b.type === "tool_use") searches++;
    out.push({ model, search: searches * SEARCH_AVG, calls: t.calls.length });
  }
  return out;
}

/** Average recorded cost per search call across all search fixtures. */
function averageSearchCost(dir = PATHS.fixtures): number {
  let total = 0, n = 0;
  for (const engine of ["exa", "brave", "exa_contents"]) {
    const d = path.join(dir, engine);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
      if (typeof j.cost_usd === "number") (total += j.cost_usd, n++);
    }
  }
  return n ? total / n : 0.008;
}
const SEARCH_AVG = averageSearchCost();

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function p90(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.9 * (s.length - 1)))];
}

function main() {
  const headroom = arg("headroom", 0.25);
  const db = openDb(PATHS.db);
  const active = db.activeIdeaIds().length;

  // Kill gate: recorded.
  const kg = recordedSamples("kill_gate");
  const kgPer = kg.map((s) => s.model + s.search);
  // Observed pass rate across distinct recorded ideas (latest recording per idea, majority of samples).
  const verdicts = new Map<string, string[]>();
  for (const f of fs.readdirSync(path.join(PATHS.fixtures, "model/kill_gate"))) {
    const t = JSON.parse(fs.readFileSync(path.join(PATHS.fixtures, "model/kill_gate", f), "utf8"));
    if (!Array.isArray(t.calls)) continue;
    const txt = t.calls[t.calls.length - 1]?.response?.content?.find((b: any) => b.type === "text")?.text ?? "";
    const m = txt.match(/\{[\s\S]*\}/);
    let v = "error";
    try {
      const j = JSON.parse(m?.[0] ?? "{}");
      v = j.tests?.some((x: any) => x.result === "fail" && x.evidence && ["R001", "T2", "T3", "T7"].includes(x.id)) ? "kill" : "pass";
    } catch { /* ignore */ }
    const id = t.idea_id as string;
    verdicts.set(id, [...(verdicts.get(id) ?? []), v]);
  }
  const ideasRecorded = [...verdicts.keys()];
  const passIdeas = ideasRecorded.filter((id) => verdicts.get(id)!.filter((v) => v === "pass").length * 2 > verdicts.get(id)!.length);
  const passRate = ideasRecorded.length ? passIdeas.length / ideasRecorded.length : 0.6;

  // Viability: recorded if present, else assumptions.
  const via = recordedSamples("viability");
  const viaAssump = { inputTokens: 90_000, cacheReadTokens: 60_000, outputTokens: 6_000, searches: 12 };
  const pr = PRICING[MODELS.viability];
  const viaPerAssumed = (viaAssump.inputTokens * pr.input + viaAssump.cacheReadTokens * pr.cache_read + viaAssump.outputTokens * pr.output) / 1e6 + viaAssump.searches * SEARCH_AVG;
  const viaPer = via.length ? mean(via.map((s) => s.model + s.search)) : viaPerAssumed;
  const completeRate = 0.75;

  // Critic: Swiss tournament, ceil(log2 n) + 1 rounds, floor(n/2) pairs per round, two orders each.
  const cr = recordedSamples("critic");
  const crAssump = { inputTokens: 5_000, outputTokens: 700 };
  const pc = PRICING[MODELS.critic];
  const crPerCallAssumed = (crAssump.inputTokens * pc.input + crAssump.outputTokens * pc.output) / 1e6;
  const crPerCall = cr.length ? mean(cr.map((s) => s.model)) : crPerCallAssumed;

  const expectedPasses = Math.round(active * passRate);
  const expectedCompletes = Math.round(expectedPasses * completeRate);
  const rounds = expectedCompletes > 1 ? Math.ceil(Math.log2(expectedCompletes)) + 1 : 0;
  const criticCalls = rounds * Math.floor(expectedCompletes / 2) * 2;

  const kgCost = active * mean(kgPer);
  const kgCostP90 = active * p90(kgPer);
  const viaCost = expectedPasses * viaPer;
  const crCost = criticCalls * crPerCall;
  const total = kgCost + viaCost + crCost;
  const totalHigh = kgCostP90 + viaCost * 1.5 + crCost * 1.5;
  const recommended = Math.ceil(Math.max(total * (1 + headroom), totalHigh) / 5) * 5;

  console.log(`Active ideas: ${active}`);
  console.log(`Kill gate: ${kg.length} recorded samples, mean $${mean(kgPer).toFixed(4)} per idea (p90 $${p90(kgPer).toFixed(4)}), observed pass rate ${(passRate * 100).toFixed(0)}% over ${ideasRecorded.length} recorded ideas`);
  console.log(`Viability: ${via.length ? `${via.length} recorded samples, mean` : "no recordings; assumed"} $${viaPer.toFixed(4)} per idea` + (via.length ? "" : ` (${viaAssump.inputTokens} input + ${viaAssump.cacheReadTokens} cached tokens, ${viaAssump.outputTokens} output, ${viaAssump.searches} searches)`) + `, assumed complete rate ${(completeRate * 100).toFixed(0)}%`);
  console.log(`Critic: ${cr.length ? `${cr.length} recorded calls, mean` : "no recordings; assumed"} $${crPerCall.toFixed(4)} per call` + (cr.length ? "" : ` (${crAssump.inputTokens} input, ${crAssump.outputTokens} output on ${MODELS.critic})`));
  console.log(`Search: mean recorded cost per call $${SEARCH_AVG.toFixed(4)}`);
  console.log("");
  console.log("| Stage | Units | Per unit | Estimate |");
  console.log("|---|---|---|---|");
  console.log(`| Kill gate | ${active} ideas | $${mean(kgPer).toFixed(3)} | $${kgCost.toFixed(2)} |`);
  console.log(`| Viability | ${expectedPasses} expected passes | $${viaPer.toFixed(3)} | $${viaCost.toFixed(2)} |`);
  console.log(`| Critic | ${expectedCompletes} completes, ${rounds} rounds, ${criticCalls} calls | $${crPerCall.toFixed(3)} | $${crCost.toFixed(2)} |`);
  console.log(`| **Total** | | | **$${total.toFixed(2)}** (high case $${totalHigh.toFixed(2)}) |`);
  console.log(`\nRecommended RUN_BUDGET_USD: ${recommended} (max of +${(headroom * 100).toFixed(0)}% headroom and the high case, rounded up to $5)`);
  db.close();
}

main();
