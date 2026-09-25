// Stage 1: kill gate. Runs the model with exa_search and brave_search tools, then applies the runner
// checks from docs/HANDOFF.md before anything is recorded:
//   1. output validates against the schema
//   2. at least 2 Exa and 2 Brave queries appear both in `queries` and as trace events, else `error`
//   3. `kill` iff a kill rule or hard test failed with non-empty evidence; the runner overrides either way
//      (kill_to_pass, pass_to_kill) and logs a runner_override event
//   4. proposed_variant becomes a new idea with parent_id; the original verdict stands
//   5. backtest rows: self_found when a competitor matches the business the row describes
// Plus: search results are data. Injection phrases found in tool results are added to injection_seen.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MODELS, renderTemplate, type PromptSet } from "../config.js";
import type { Db, AgentSafeRule } from "../store/db.js";
import type { SearchClients } from "../search/index.js";
import { normalizeQuery } from "../search/fixtures.js";
import { BudgetExceededError, type ModelClient } from "../model/client.js";
import type { TraceCollector, TraceEvent } from "../trace.js";

export const KillGateOutput = z.object({
  idea_id: z.string(),
  verdict: z.enum(["pass", "kill"]),
  tests: z
    .array(
      z.object({
        id: z.string(),
        result: z.enum(["pass", "fail", "unknown"]),
        evidence: z.string().default(""),
        source_url: z.string().nullable().optional().default(null),
      }),
    )
    .default([]),
  flags: z.array(z.object({ id: z.string(), evidence: z.string().default(""), obligations: z.array(z.string()).default([]) })).default([]),
  competitors: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().nullable().optional().default(null),
        relationship: z.enum(["direct", "adjacent"]).catch("adjacent"),
        pricing: z.string().nullable().optional().default(null),
        evidence: z.string().default(""),
      }),
    )
    .default([]),
  queries: z.object({ exa: z.array(z.string()).default([]), brave: z.array(z.string()).default([]) }).default({ exa: [], brave: [] }),
  proposed_variant: z.object({ idea: z.string(), reason: z.string().default("") }).nullable().optional().default(null),
  injection_seen: z.array(z.string()).default([]),
});
export type KillGateOutputT = z.infer<typeof KillGateOutput>;

export interface RunnerNotes {
  model_verdict: "pass" | "kill" | null;
  overrides: string[];
  remarks: string[];
  variant_id: string | null;
  self_found: boolean;
}

export type KillGatePayload = Omit<KillGateOutputT, "verdict"> & {
  verdict: "pass" | "kill" | "error";
  error?: string;
  raw_output?: string | null;
  runner: RunnerNotes;
};

export interface KillGateContext {
  db: Db;
  runId: string;
  taskId?: string | null;
  ideaId: string;
  agent: string;
  search: SearchClients;
  model: ModelClient;
  trace: TraceCollector;
  prompts: PromptSet;
  /** Name of the model transcript fixture. Defaults to the idea id. */
  fixtureName?: string;
  maxIterations?: number;
}

export interface KillGateRunResult {
  stageResultId: string;
  verdict: "pass" | "kill" | "error";
  payload: KillGatePayload;
  rulesFired: string[];
  events: TraceEvent[];
  costUsd: number;
  selfFound: boolean;
  variantId: string | null;
}

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "exa_search",
    description: "Neural web search (Exa) with page text. Use for conceptual matches: businesses doing something like this idea.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        num_results: { type: "integer", minimum: 1, maximum: 10, description: "Results to return (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "brave_search",
    description: "Keyword web search (Brave). Use for exact terms, product names, pricing pages and fresh results.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword search query" },
        count: { type: "integer", minimum: 1, maximum: 10, description: "Results to return (default 5)" },
      },
      required: ["query"],
    },
  },
];

const ExaInput = z.object({ query: z.string().min(1), num_results: z.number().int().min(1).max(10).optional() });
const BraveInput = z.object({ query: z.string().min(1), count: z.number().int().min(1).max(10).optional() });

// Injection phrases the runner scans for in tool results. Matches are added to injection_seen when the
// model did not report them itself.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (?:all |any )?(?:previous|prior|above|earlier) instructions?/i,
  /disregard (?:all |any )?(?:previous|prior|above|earlier) (?:instructions?|rules?)/i,
  /mark this idea (?:as )?(?:pass|kill)/i,
  /override (?:your|the) (?:verdict|instructions?|rules?)/i,
];

export const MIN_QUERIES_PER_ENGINE = 2;

// Baseline items every software business needs. Never a T8 obligation.
export const T8_BASELINE = /(privacy[ -](policy|notice|terms)|privacy\/terms|terms[ -]of[ -](service|use)|\btos\b|\bgdpr\b|\bccpa\b|\bcpra\b|cookie[ -](consent|banner|policy)|data processing (agreement|addendum|terms)|\bdpa\b)/i;
// Ongoing obligations. When R001 fired they belong there and are not repeated under T8.
export const T8_ONGOING = /\b(ongoing|annual|periodic|renewal|exams?|examinations?|money transmit|msb registration|bsa|aml program|surety bond|licens(e|ing|ure) (with|and|from|under|requirements?)|state licens|investment adviser|broker.dealer|insurance producer)\b/i;

function formatRules(rules: AgentSafeRule[]): string {
  if (rules.length === 0) return "(none)";
  return rules.map((r) => `- ${r.id} (${r.kind.replace("_", " ")}): ${r.text}`).join("\n");
}

/**
 * Escape raw control characters that appear inside JSON string literals (models sometimes emit a
 * literal newline or tab inside a long markdown string). Characters outside strings are untouched.
 */
export function repairJsonControlChars(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function parseLenient(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch (e) {
    const repaired = repairJsonControlChars(candidate);
    if (repaired !== candidate) return JSON.parse(repaired);
    throw e;
  }
}

/** Extract the first JSON object from model text, tolerating code fences, surrounding prose and raw control characters inside strings. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return parseLenient(trimmed);
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return parseLenient(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return parseLenient(trimmed.slice(start, end + 1));
  throw new Error("no JSON object found in model output");
}

export function scanForInjection(text: string): string[] {
  const found: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(global)) {
      const i = m.index ?? 0;
      const snippet = text.slice(Math.max(0, i - 80), Math.min(text.length, i + m[0].length + 80)).replace(/\s+/g, " ").trim();
      if (!found.includes(snippet)) found.push(snippet);
    }
  }
  return found;
}

function emptyOutput(ideaId: string): Omit<KillGateOutputT, "verdict"> {
  return { idea_id: ideaId, tests: [], flags: [], competitors: [], queries: { exa: [], brave: [] }, proposed_variant: null, injection_seen: [] };
}

export async function runKillGate(ctx: KillGateContext): Promise<KillGateRunResult> {
  const { db, trace, search, ideaId } = ctx;
  const model = MODELS.kill_gate;
  const promptHash = ctx.prompts.kill_gate.hash;
  const maxIterations = ctx.maxIterations ?? 12;
  let costUsd = 0;
  const runner: RunnerNotes = { model_verdict: null, overrides: [], remarks: [], variant_id: null, self_found: false };

  const record = (verdict: "pass" | "kill" | "error", payload: KillGatePayload, rulesFired: string[], selfFound: boolean, variantId: string | null): KillGateRunResult => {
    // Live search spend counts against the run budget alongside model spend.
    const searchUsd = search.liveSpendUsd();
    if (searchUsd > 0) {
      costUsd += searchUsd;
      trace.add("runner_note", { note: "search_spend", usd: Number(searchUsd.toFixed(4)) });
    }
    trace.add("output", { verdict, rules_fired: rulesFired, self_found: selfFound, payload });
    const row = db.recordStageResult({
      runId: ctx.runId, ideaId, stage: "kill_gate", verdict, payload, rulesFired, selfFound, model, agent: ctx.agent, promptHash, costUsd, events: trace.toInputs(), taskId: ctx.taskId ?? null,
    });
    return { stageResultId: row.id, verdict, payload, rulesFired, events: trace.events, costUsd, selfFound, variantId };
  };
  const fail = (error: string, rawOutput: string | null, partial?: Partial<KillGateOutputT>) => {
    trace.add("error", { error });
    const payload: KillGatePayload = { ...emptyOutput(ideaId), ...(partial ?? {}), verdict: "error", error, raw_output: rawOutput, runner };
    return record("error", payload, [], false, null);
  };

  const idea = db.getAgentSafeIdea(ideaId);
  if (!idea) throw new Error(`idea ${ideaId} not found`);

  const active = db.activeRules();
  const hardRules = active.filter((r) => r.kind === "kill_rule" || r.kind === "hard_test");
  const softRules = active.filter((r) => r.kind === "soft_test");
  const hardIds = new Set(hardRules.map((r) => r.id));

  const system = renderTemplate(ctx.prompts.kill_gate.text, {
    hard_rules: formatRules(hardRules),
    soft_rules: formatRules(softRules),
    idea_id: idea.id,
    idea: idea.idea,
    customer: idea.customer,
    verbatim_quote: idea.verbatim_quote,
  });
  trace.add("system", { model, prompt_hash: promptHash, system_prompt: system });
  trace.add("input", { idea, hard_rules: hardRules, soft_rules: softRules, tools: TOOLS.map((t) => t.name) });

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: `Evaluate idea ${idea.id} now. Run the required searches with the tools, then return only the JSON object.` },
  ];
  const session = ctx.model.session("kill_gate", ideaId, ctx.fixtureName);
  let finalText: string | null = null;

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 16000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
      };
      const r = await session.call(params);
      costUsd += r.costUsd;
      trace.add("model_call", {
        iteration, model, source: r.source, message_count: messages.length, stop_reason: r.message.stop_reason, usage: r.message.usage, cost_usd: r.costUsd,
        content: r.message.content, ...(r.digestMismatch ? { note: "replayed request differs from the recorded request at this position" } : {}),
      });
      if (r.digestMismatch) runner.remarks.push(`model call ${iteration}: replayed request differs from recording`);

      const toolUses = r.message.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use");
      if (r.message.stop_reason === "tool_use" && toolUses.length > 0) {
        messages.push({ role: "assistant", content: r.message.content });
        const results: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          results.push(await executeTool(search, tu));
        }
        messages.push({ role: "user", content: results });
        continue;
      }
      if (r.message.stop_reason === "refusal") return fail("model refused the request", null);
      if (r.message.stop_reason === "max_tokens") return fail("model output truncated at max_tokens", null);
      finalText = r.message.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const result = fail(`stage call failed: ${message}`, null);
    if (e instanceof BudgetExceededError) throw e;
    return result;
  }
  if (finalText == null) return fail(`no final answer after ${maxIterations} model calls`, null);

  // 1. Validate.
  let parsed: KillGateOutputT;
  try {
    parsed = KillGateOutput.parse(extractJson(finalText));
  } catch (e) {
    return fail(`output failed validation: ${e instanceof Error ? e.message : String(e)}`, finalText);
  }
  runner.model_verdict = parsed.verdict;
  if (parsed.idea_id !== idea.id) runner.remarks.push(`model reported idea_id ${parsed.idea_id}; expected ${idea.id}`);

  // 2. Query coverage: declared in `queries` and actually run (successful tool_result events).
  const ran = (engine: "exa" | "brave") =>
    new Set(trace.ofKind("tool_result").filter((e) => (e.content as any)?.engine === engine && (e.content as any)?.ok).map((e) => normalizeQuery(String((e.content as any).query)).toLowerCase()));
  const declared = (list: string[]) => new Set(list.map((q) => normalizeQuery(q).toLowerCase()));
  const coverage: Record<string, { declared: number; ran: number; matched: number }> = {};
  const shortfalls: string[] = [];
  for (const engine of ["exa", "brave"] as const) {
    const d = declared(parsed.queries[engine]);
    const r = ran(engine);
    const matched = [...d].filter((q) => r.has(q)).length;
    coverage[engine] = { declared: d.size, ran: r.size, matched };
    if (matched < MIN_QUERIES_PER_ENGINE) shortfalls.push(`${engine}: ${matched} of the required ${MIN_QUERIES_PER_ENGINE} queries appear both in queries and as trace events (declared ${d.size}, ran ${r.size})`);
  }
  trace.add("runner_check", { check: "query_coverage", coverage, ok: shortfalls.length === 0 });
  if (shortfalls.length > 0) return fail(`insufficient search coverage: ${shortfalls.join("; ")}`, finalText, parsed);

  // 3. Kill legitimacy. Only an active kill rule or hard test that failed with evidence can kill.
  const rulesFired = parsed.tests.filter((t) => t.result === "fail" && t.evidence.trim().length > 0 && hardIds.has(t.id)).map((t) => t.id);
  const ignoredFails = parsed.tests.filter((t) => t.result === "fail" && !rulesFired.includes(t.id));
  for (const t of ignoredFails) {
    const why = !hardIds.has(t.id) ? "not an active kill rule or hard test" : "no evidence cited";
    runner.remarks.push(`test ${t.id} marked fail but does not count: ${why}`);
    trace.add("runner_note", { note: "fail_not_counted", test: t.id, why });
  }
  let verdict: "pass" | "kill" = parsed.verdict;
  if (verdict === "kill" && rulesFired.length === 0) {
    verdict = "pass";
    runner.overrides.push("kill_to_pass: no hard test failed with cited evidence");
    trace.add("runner_override", { kind: "kill_to_pass", from: "kill", to: "pass", reason: "no hard test failed with cited evidence", tests: parsed.tests });
  } else if (verdict === "pass" && rulesFired.length > 0) {
    verdict = "kill";
    runner.overrides.push(`pass_to_kill: ${rulesFired.join(", ")} failed with cited evidence`);
    trace.add("runner_override", { kind: "pass_to_kill", from: "pass", to: "kill", reason: "a kill rule or hard test failed with cited evidence", rules_fired: rulesFired });
  }

  // T8 flags must name specific one-time obligations beyond the baseline every software business
  // needs, and must not repeat ongoing obligations that belong to R001. Baseline items are dropped,
  // ongoing items are dropped when R001 fired, and a T8 flag with nothing left is removed.
  const flags = parsed.flags.flatMap((f) => {
    if (f.id !== "T8") return [f];
    const named = f.obligations.map((o) => o.trim()).filter(Boolean);
    const baseline = named.filter((o) => T8_BASELINE.test(o));
    const ongoing = rulesFired.includes("R001") ? named.filter((o) => !T8_BASELINE.test(o) && T8_ONGOING.test(o)) : [];
    const kept = named.filter((o) => !baseline.includes(o) && !ongoing.includes(o));
    if (baseline.length || ongoing.length || named.length === 0) {
      trace.add("runner_note", { note: "t8_obligations_filtered", named, dropped_baseline: baseline, dropped_ongoing_r001: ongoing, kept });
      if (named.length === 0) runner.remarks.push("T8 flag named no obligations");
      if (baseline.length) runner.remarks.push(`T8: dropped ${baseline.length} baseline item(s)`);
      if (ongoing.length) runner.remarks.push(`T8: dropped ${ongoing.length} ongoing item(s) already covered by R001`);
    }
    if (kept.length === 0) {
      runner.remarks.push("T8 flag removed: no one-time obligation beyond the baseline");
      trace.add("runner_override", { kind: "t8_flag_removed", reason: named.length ? "only baseline or R001-covered items" : "no obligations named", evidence: f.evidence });
      return [];
    }
    return [{ ...f, obligations: kept }];
  });

  // Injection scan over everything the tools returned.
  const injectionSeen = [...parsed.injection_seen];
  const toolText = trace.ofKind("tool_result").map((e) => JSON.stringify((e.content as any)?.result ?? "")).join("\n");
  const detected = scanForInjection(toolText);
  const missed = detected.filter((snippet) => !injectionSeen.some((s) => snippet.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(snippet.toLowerCase())));
  if (detected.length > 0) trace.add("runner_check", { check: "injection_scan", detected, reported_by_model: parsed.injection_seen, added_by_runner: missed });
  for (const m of missed) injectionSeen.push(`[runner-detected] ${m}`);

  // 4. Proposed variant becomes a child idea. The original verdict stands.
  let variantId: string | null = null;
  if (parsed.proposed_variant && parsed.proposed_variant.idea.trim()) {
    const variant = db.createIdea({ idea: parsed.proposed_variant.idea.trim(), customer: idea.customer, parent_id: idea.id });
    variantId = variant.id;
    runner.variant_id = variantId;
    trace.add("runner_note", { note: "variant_created", variant_id: variantId, parent_id: idea.id, reason: parsed.proposed_variant.reason });
  }

  // 5. Backtest contamination. The runner only learns a boolean.
  const selfFound = db.matchesBacktestBusiness(idea.id, parsed.competitors.map((c) => ({ name: c.name, url: c.url })));
  runner.self_found = selfFound;
  if (selfFound) trace.add("runner_note", { note: "self_found", detail: "a competitor matches the business this backtest row describes" });

  const payload: KillGatePayload = { ...parsed, flags, verdict, injection_seen: injectionSeen, runner };
  return record(verdict, payload, rulesFired, selfFound, variantId);
}

async function executeTool(search: SearchClients, tu: Anthropic.Messages.ToolUseBlock): Promise<Anthropic.Messages.ToolResultBlockParam> {
  try {
    if (tu.name === "exa_search") {
      const input = ExaInput.parse(tu.input);
      const r = await search.exa_search(input.query, input.num_results ?? 5);
      return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(r.results) };
    }
    if (tu.name === "brave_search") {
      const input = BraveInput.parse(tu.input);
      const r = await search.brave_search(input.query, input.count ?? 5);
      return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(r.results) };
    }
    return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: `unknown tool ${tu.name}` };
  } catch (e) {
    return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: `${tu.name} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
