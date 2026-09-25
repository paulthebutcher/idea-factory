// Stage 3: critic. Swiss tournament over ideas whose viability verdict is complete.
//   - ceil(log2(n)) + 1 rounds; pair ideas with equal or near-equal scores; never repeat a pair
//   - each pair runs twice, A first then B first; if the two winners differ the result is tie
//   - briefs go in with idea ids replaced by "Idea A" and "Idea B"; company names stay
//   - rank by wins plus half a point per tie; break ties by the sum of opponents' scores
//   - every comparison is stored in `comparisons` with both orders and the rationale, linked to a
//     stage_result that holds the trace events of both model calls
// A bye (odd field) counts as a win and is derivable from comparisons: the idea did not play that round.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MODELS, renderTemplate, type PromptSet } from "../config.js";
import type { Db } from "../store/db.js";
import { BudgetExceededError, FatalApiError, type ModelClient } from "../model/client.js";
import { TraceCollector } from "../trace.js";
import { extractJson } from "./kill_gate.js";

export const CriticOutput = z.object({
  winner: z.enum(["A", "B"]),
  reasons: z.array(z.string()).default([]),
  weakest_evidence_in_loser: z.string().default(""),
  confidence_note: z.string().default(""),
});
export type CriticOutputT = z.infer<typeof CriticOutput>;

export interface ComparisonRow {
  id: number;
  run_id: string;
  round: number;
  idea_a: string;
  idea_b: string;
  order_ab: "A" | "B";
  order_ba: "A" | "B";
  result: "A" | "B" | "tie";
  rationale_json: string;
  model: string;
  stage_result_id: string | null;
  created_at: string;
}

export interface Standing {
  ideaId: string;
  wins: number;
  ties: number;
  losses: number;
  byes: number;
  score: number;
  opponents: string[];
  opponentScore: number;
  rank: number;
}

export function swissRounds(n: number): number {
  return n > 1 ? Math.ceil(Math.log2(n)) + 1 : 0;
}

/**
 * Rank from comparisons alone. Score = wins + 0.5 per tie + 1 per bye. A bye is inferred: an idea in
 * the field that has no comparison in a round that was played. Tie-break: sum of opponents' scores.
 */
export function rankFromComparisons(ideaIds: string[], comparisons: Pick<ComparisonRow, "round" | "idea_a" | "idea_b" | "result">[]): Standing[] {
  const s = new Map<string, Standing>(ideaIds.map((id) => [id, { ideaId: id, wins: 0, ties: 0, losses: 0, byes: 0, score: 0, opponents: [], opponentScore: 0, rank: 0 }]));
  const rounds = [...new Set(comparisons.map((c) => c.round))];
  for (const c of comparisons) {
    const a = s.get(c.idea_a)!, b = s.get(c.idea_b)!;
    if (!a || !b) continue;
    a.opponents.push(c.idea_b);
    b.opponents.push(c.idea_a);
    if (c.result === "tie") (a.ties++, b.ties++);
    else if (c.result === "A") (a.wins++, b.losses++);
    else (b.wins++, a.losses++);
  }
  for (const r of rounds) {
    const played = new Set(comparisons.filter((c) => c.round === r).flatMap((c) => [c.idea_a, c.idea_b]));
    for (const id of ideaIds) if (!played.has(id)) s.get(id)!.byes++;
  }
  for (const x of s.values()) x.score = x.wins + 0.5 * x.ties + x.byes;
  for (const x of s.values()) x.opponentScore = x.opponents.reduce((acc, o) => acc + (s.get(o)?.score ?? 0), 0);
  const ranked = [...s.values()].sort((x, y) => y.score - x.score || y.opponentScore - x.opponentScore || x.ideaId.localeCompare(y.ideaId));
  ranked.forEach((x, i) => (x.rank = i + 1));
  return ranked;
}

/** Swiss pairing for one round: sort by score, pair adjacent ideas that have not met; odd one out gets a bye. */
export function pairRound(standings: Standing[], played: Set<string>): { pairs: [string, string][]; bye: string | null } {
  const order = [...standings].sort((x, y) => y.score - x.score || y.opponentScore - x.opponentScore || x.ideaId.localeCompare(y.ideaId)).map((x) => x.ideaId);
  const key = (a: string, b: string) => [a, b].sort().join("|");
  const pairs: [string, string][] = [];
  const used = new Set<string>();
  // Backtracking search for a full pairing without repeats; small n so this is cheap.
  const search = (remaining: string[]): [string, string][] | null => {
    if (remaining.length <= 1) return [];
    const [first, ...rest] = remaining;
    for (let i = 0; i < rest.length; i++) {
      if (played.has(key(first, rest[i]))) continue;
      const sub = search([...rest.slice(0, i), ...rest.slice(i + 1)]);
      if (sub) return [[first, rest[i]], ...sub];
    }
    return null;
  };
  let bye: string | null = null;
  let candidates = order;
  if (order.length % 2 === 1) {
    // Give the bye to the lowest-ranked idea that has not had one, falling back to the lowest.
    const noBye = [...order].reverse().find((id) => (standings.find((s) => s.ideaId === id)?.byes ?? 0) === 0) ?? order[order.length - 1];
    bye = noBye;
    candidates = order.filter((id) => id !== noBye);
  }
  const found = search(candidates) ?? (() => {
    // No repeat-free pairing exists (tiny fields late in the tournament): allow repeats, adjacent pairing.
    const out: [string, string][] = [];
    for (let i = 0; i + 1 < candidates.length; i += 2) out.push([candidates[i], candidates[i + 1]]);
    return out;
  })();
  for (const [a, b] of found) (used.add(a), used.add(b), pairs.push([a, b]));
  return { pairs, bye };
}

function blindBrief(brief: string, ideaId: string, label: string): string {
  return brief.split(ideaId).join(label);
}

export interface CriticContext {
  db: Db;
  runId: string;
  ideaIds: string[];
  agent: string;
  model: ModelClient;
  prompts: PromptSet;
  /** Called before each model call; throw BudgetExceededError to stop. */
  beforeCall?: () => void;
  onComparison?: (c: ComparisonRow) => void;
  /** Pairs within a round judged this many at a time. Default 1. Rounds stay sequential. */
  concurrency?: number;
}

export interface CriticRunSummary {
  ideaIds: string[];
  rounds: number;
  comparisons: ComparisonRow[];
  standings: Standing[];
  costUsd: number;
}

async function judge(ctx: CriticContext, trace: TraceCollector, fixtureName: string, briefA: string, briefB: string, label: string): Promise<{ out: CriticOutputT; cost: number; raw: string }> {
  const system = renderTemplate(ctx.prompts.critic.text, { brief_a: briefA, brief_b: briefB });
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: MODELS.critic,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: "Compare the two briefs and return only the JSON object." }],
  };
  ctx.beforeCall?.();
  const session = ctx.model.session("critic", fixtureName, fixtureName);
  const r = await session.call(params);
  const raw = r.message.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map((b) => b.text).join("\n");
  trace.add("model_call", { order: label, model: MODELS.critic, source: r.source, stop_reason: r.message.stop_reason, usage: r.message.usage, cost_usd: r.costUsd, content: r.message.content });
  if (r.message.stop_reason === "refusal") throw new Error("critic refused");
  const out = CriticOutput.parse(extractJson(raw));
  return { out, cost: r.costUsd, raw };
}

/** Run the tournament. Each comparison writes a stage_result (idea_a, stage critic) with both calls' events plus a comparisons row. */
export async function runCritic(ctx: CriticContext): Promise<CriticRunSummary> {
  const { db } = ctx;
  const ideaIds = [...ctx.ideaIds];
  const briefs = new Map<string, string>();
  for (const id of ideaIds) {
    const v = db.latestStageResult(id, "viability");
    if (!v || v.verdict !== "complete" || !v.doc_md) throw new Error(`idea ${id} has no complete viability brief`);
    briefs.set(id, v.doc_md);
  }
  const rounds = swissRounds(ideaIds.length);
  const played = new Set<string>();
  const comparisons: ComparisonRow[] = [];
  let costUsd = 0;
  const insert = db.raw.prepare(
    "INSERT INTO comparisons (run_id, round, idea_a, idea_b, order_ab, order_ba, result, rationale_json, model, stage_result_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const concurrency = Math.max(1, ctx.concurrency ?? 1);
  const judgePair = async (round: number, a: string, b: string): Promise<ComparisonRow> => {
    const trace = new TraceCollector();
    trace.add("system", { model: MODELS.critic, prompt_hash: ctx.prompts.critic.hash, round, idea_a: a, idea_b: b });
    trace.add("input", { round, idea_a: a, idea_b: b, brief_a_chars: briefs.get(a)!.length, brief_b_chars: briefs.get(b)!.length, blinding: "idea ids replaced by Idea A / Idea B" });
    try {
      // Order AB: a is Idea A. Order BA: b is Idea A; map the winner back to a/b.
      const ab = await judge(ctx, trace, `${a}__${b}__ab`, blindBrief(briefs.get(a)!, a, "Idea A"), blindBrief(briefs.get(b)!, b, "Idea B"), "ab");
      const ba = await judge(ctx, trace, `${a}__${b}__ba`, blindBrief(briefs.get(b)!, b, "Idea A"), blindBrief(briefs.get(a)!, a, "Idea B"), "ba");
      const orderAb: "A" | "B" = ab.out.winner;
      const orderBa: "A" | "B" = ba.out.winner === "A" ? "B" : "A";
      const result: "A" | "B" | "tie" = orderAb === orderBa ? orderAb : "tie";
      const rationale = { ab: ab.out, ba: ba.out };
      trace.add("output", { round, idea_a: a, idea_b: b, order_ab: orderAb, order_ba: orderBa, result, rationale });
      const sr = db.recordStageResult({
        runId: ctx.runId, ideaId: a, stage: "critic", verdict: "complete",
        payload: { kind: "comparison", round, idea_a: a, idea_b: b, order_ab: orderAb, order_ba: orderBa, result, rationale },
        model: MODELS.critic, agent: ctx.agent, promptHash: ctx.prompts.critic.hash, costUsd: ab.cost + ba.cost, events: trace.toInputs(),
      });
      const info = insert.run(ctx.runId, round, a, b, orderAb, orderBa, result, JSON.stringify(rationale), MODELS.critic, sr.id);
      const row = db.raw.prepare("SELECT * FROM comparisons WHERE id = ?").get(info.lastInsertRowid) as ComparisonRow;
      ctx.onComparison?.(row);
      return row;
    } catch (e) {
      if (e instanceof BudgetExceededError || e instanceof FatalApiError) throw e;
      // A tournament with a missing comparison cannot be ranked (the hole would read as a bye), so
      // record the error trace and abort the tournament.
      const message = e instanceof Error ? e.message : String(e);
      trace.add("error", { error: message });
      db.recordStageResult({
        runId: ctx.runId, ideaId: a, stage: "critic", verdict: "error",
        payload: { kind: "comparison", round, idea_a: a, idea_b: b, error: message },
        model: MODELS.critic, agent: ctx.agent, promptHash: ctx.prompts.critic.hash, costUsd: 0, events: trace.toInputs(),
      });
      throw new Error(`critic comparison ${a} vs ${b} (round ${round}) failed: ${message}`);
    }
  };

  for (let round = 1; round <= rounds; round++) {
    const standings = rankFromComparisons(ideaIds, comparisons);
    const { pairs } = pairRound(standings, played);
    for (const [a, b] of pairs) played.add([a, b].sort().join("|"));
    // Pairs of a round are independent; judge them concurrently, keep the round order stable.
    const roundRows: ComparisonRow[] = [];
    let next = 0;
    const worker = async () => {
      while (next < pairs.length) {
        const [a, b] = pairs[next++];
        roundRows.push(await judgePair(round, a, b));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, worker));
    roundRows.sort((x, y) => x.id - y.id);
    for (const row of roundRows) {
      comparisons.push(row);
      const r = JSON.parse(row.rationale_json);
      void r;
    }
    costUsd += roundRows.reduce((acc, row) => acc + ((db.getStageResult(row.stage_result_id!)?.cost_usd) ?? 0), 0);
  }

  const standings = rankFromComparisons(ideaIds, comparisons);
  // One critic record per idea for the ledger: rank and tally, with the comparison ids as its trace.
  for (const st of standings) {
    const trace = new TraceCollector();
    const mine = comparisons.filter((c) => c.idea_a === st.ideaId || c.idea_b === st.ideaId).map((c) => c.id);
    trace.add("input", { comparison_ids: mine, field: ideaIds, rounds });
    trace.add("output", { ...st });
    db.recordStageResult({
      runId: ctx.runId, ideaId: st.ideaId, stage: "critic", verdict: "complete",
      payload: { kind: "standing", ...st, comparison_ids: mine },
      model: MODELS.critic, agent: ctx.agent, promptHash: ctx.prompts.critic.hash, costUsd: 0, events: trace.toInputs(),
    });
  }
  return { ideaIds, rounds, comparisons, standings, costUsd };
}
