// Stage 2: viability. Runs on kill-gate passes with exa_search, brave_search and fetch_page, then
// applies the runner checks from docs/HANDOFF.md before recording:
//   1. output validates against the schema
//   2. every URL in the output appears in a tool_result trace event from this call; a URL the model
//      never retrieved is moved to unsourced_claims and logged (runner_override unsourced_url_moved)
//   3. verdict complete only when payer.comparable_url, competitors (or 3+ not-found queries),
//      acquisition_channel, demand_evidence, case_for and case_against are all present and none is
//      NOT FOUND; otherwise fail_evidence. Partial passes do not exist.
//   4. brief_md is stored in stage_results.doc_md
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MODELS, renderTemplate, type PromptSet } from "../config.js";
import type { Db } from "../store/db.js";
import type { SearchClients } from "../search/index.js";
import { BudgetExceededError, type ModelClient } from "../model/client.js";
import type { TraceCollector, TraceEvent } from "../trace.js";
import { extractJson, scanForInjection } from "./kill_gate.js";

const NOT_FOUND = "NOT FOUND";
const urlOrNull = z.string().nullable().optional().default(null);

export const ViabilityOutput = z.object({
  idea_id: z.string(),
  payer: z.object({ who: z.string().default(""), price_hypothesis: z.string().default(""), comparable_url: z.string().nullable().optional().default(NOT_FOUND) }).default({ who: "", price_hypothesis: "", comparable_url: NOT_FOUND }),
  competitors: z.array(z.object({ name: z.string(), url: urlOrNull, pricing: z.string().nullable().optional().default(null), pricing_url: urlOrNull })).default([]),
  competitors_not_found_queries: z.array(z.string()).default([]),
  acquisition_channel: z.array(z.object({ channel: z.string(), cost_estimate: z.string().default(""), source_url: urlOrNull })).default([]),
  demand_evidence: z.array(z.object({ quote: z.string(), url: urlOrNull })).default([]),
  case_for: z.string().default(""),
  case_against: z.string().default(""),
  open_questions: z.array(z.string()).default([]),
  regulatory_setup: z
    .object({ obligations: z.array(z.object({ obligation: z.string(), kind: z.enum(["one_time", "ongoing"]).catch("one_time"), consult_scope: z.string().default(""), source_url: urlOrNull })).default([]) })
    .nullable()
    .optional()
    .default(null),
  unsourced_claims: z.array(z.string()).default([]),
  injection_seen: z.array(z.string()).default([]),
  brief_md: z.string().default(""),
});
export type ViabilityOutputT = z.infer<typeof ViabilityOutput>;

export interface ViabilityRunnerNotes {
  missing: string[];
  unsourced_moved: { field: string; url: string }[];
  notes: string[];
}

export type ViabilityPayload = Omit<ViabilityOutputT, never> & {
  verdict: "complete" | "fail_evidence" | "error";
  error?: string;
  raw_output?: string | null;
  runner: ViabilityRunnerNotes;
};

export interface ViabilityContext {
  db: Db;
  runId: string;
  taskId?: string | null;
  ideaId: string;
  agent: string;
  search: SearchClients;
  model: ModelClient;
  trace: TraceCollector;
  prompts: PromptSet;
  fixtureName?: string;
  maxIterations?: number;
}

export interface ViabilityRunResult {
  stageResultId: string;
  verdict: "complete" | "fail_evidence" | "error";
  payload: ViabilityPayload;
  events: TraceEvent[];
  costUsd: number;
  docMd: string | null;
}

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "exa_search",
    description: "Neural web search (Exa) with page text. Use for conceptual matches: comparable products, pricing pages, people describing this pain.",
    input_schema: { type: "object", properties: { query: { type: "string" }, num_results: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"] },
  },
  {
    name: "brave_search",
    description: "Keyword web search (Brave). Use for exact product names, pricing pages, forum threads and fresh results.",
    input_schema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"] },
  },
  {
    name: "fetch_page",
    description: "Fetch the text of one URL you found in search results, e.g. a pricing page or a forum thread, to quote it accurately.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];
const ExaInput = z.object({ query: z.string().min(1), num_results: z.number().int().min(1).max(10).optional() });
const BraveInput = z.object({ query: z.string().min(1), count: z.number().int().min(1).max(10).optional() });
const FetchInput = z.object({ url: z.string().min(1) });

export function normalizeUrl(u: string): string {
  return u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/#.*$/, "").replace(/\/+$/, "");
}

function isUrl(s: string | null | undefined): s is string {
  return typeof s === "string" && /^https?:\/\//i.test(s.trim());
}

function present(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0 && s.trim().toUpperCase() !== NOT_FOUND;
}

/** URLs the model actually retrieved in this call, from tool_result events. */
export function retrievedUrls(trace: TraceCollector): { set: Set<string>; text: string } {
  const set = new Set<string>();
  const chunks: string[] = [];
  for (const e of trace.ofKind("tool_result")) {
    const c = e.content as any;
    if (!c?.ok) continue;
    chunks.push(JSON.stringify(c.result ?? ""));
    const r = c.result;
    if (r?.results) for (const x of r.results) if (isUrl(x.url)) set.add(normalizeUrl(x.url));
    if (isUrl(r?.url)) set.add(normalizeUrl(r.url));
    if (c.tool === "fetch_page" && isUrl(c.query)) set.add(normalizeUrl(c.query));
  }
  return { set, text: chunks.join("\n") };
}

export async function runViability(ctx: ViabilityContext): Promise<ViabilityRunResult> {
  const { db, trace, search, ideaId } = ctx;
  const model = MODELS.viability;
  const promptHash = ctx.prompts.viability.hash;
  const maxIterations = ctx.maxIterations ?? 25;
  let costUsd = 0;
  const runner: ViabilityRunnerNotes = { missing: [], unsourced_moved: [], notes: [] };

  const record = (verdict: ViabilityRunResult["verdict"], payload: ViabilityPayload): ViabilityRunResult => {
    trace.add("output", { verdict, missing: payload.runner.missing, unsourced_moved: payload.runner.unsourced_moved, payload: { ...payload, brief_md: undefined } });
    const docMd = payload.brief_md?.trim() ? payload.brief_md : null;
    const row = db.recordStageResult({ runId: ctx.runId, ideaId, stage: "viability", verdict, payload, docMd, rulesFired: [], selfFound: false, model, agent: ctx.agent, promptHash, costUsd, events: trace.toInputs(), taskId: ctx.taskId ?? null });
    return { stageResultId: row.id, verdict, payload, events: trace.events, costUsd, docMd };
  };
  const fail = (error: string, rawOutput: string | null, partial?: Partial<ViabilityOutputT>) => {
    trace.add("error", { error });
    const base = ViabilityOutput.parse({ idea_id: ideaId, ...(partial ?? {}) });
    return record("error", { ...base, verdict: "error", error, raw_output: rawOutput, runner });
  };

  const idea = db.getAgentSafeIdea(ideaId);
  if (!idea) throw new Error(`idea ${ideaId} not found`);
  const kg = db.latestStageResult(ideaId, "kill_gate");
  let kgCompetitors: unknown[] = [];
  if (kg) {
    try {
      kgCompetitors = (JSON.parse(kg.payload_json).competitors ?? []).map((c: any) => ({ name: c.name, url: c.url, relationship: c.relationship, pricing: c.pricing }));
    } catch {
      /* ignore */
    }
  }

  const system = renderTemplate(ctx.prompts.viability.text, {
    idea_id: idea.id,
    idea: idea.idea,
    customer: idea.customer,
    verbatim_quote: idea.verbatim_quote,
    source_url: idea.source_url,
    kill_gate_competitors: kgCompetitors.length ? JSON.stringify(kgCompetitors) : "(none)",
  });
  trace.add("system", { model, prompt_hash: promptHash, system_prompt: system });
  trace.add("input", { idea, kill_gate_competitors: kgCompetitors, kill_gate_result_id: kg?.id ?? null, tools: TOOLS.map((t) => t.name) });

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: `Research idea ${idea.id} now. Use the tools to gather sourced evidence for every required field, then return only the JSON object.` },
  ];
  const session = ctx.model.session("viability", ideaId, ctx.fixtureName);
  let finalText: string | null = null;
  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 16000,
        system,
        tools: TOOLS,
        messages,
        cache_control: { type: "ephemeral" },
      };
      const r = await session.call(params);
      costUsd += r.costUsd;
      trace.add("model_call", { iteration, model, source: r.source, message_count: messages.length, stop_reason: r.message.stop_reason, usage: r.message.usage, cost_usd: r.costUsd, content: r.message.content, ...(r.digestMismatch ? { note: "replayed request differs from the recorded request at this position" } : {}) });
      const toolUses = r.message.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use");
      if (r.message.stop_reason === "tool_use" && toolUses.length > 0) {
        messages.push({ role: "assistant", content: r.message.content });
        const results: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const tu of toolUses) results.push(await executeTool(search, tu));
        messages.push({ role: "user", content: results });
        continue;
      }
      if (r.message.stop_reason === "refusal") return fail("model refused the request", null);
      if (r.message.stop_reason === "max_tokens") return fail("model output truncated at max_tokens", null);
      finalText = r.message.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      break;
    }
  } catch (e) {
    const result = fail(`stage call failed: ${e instanceof Error ? e.message : String(e)}`, null);
    if (e instanceof BudgetExceededError) throw e;
    return result;
  }
  if (finalText == null) return fail(`no final answer after ${maxIterations} model calls`, null);

  // 1. Validate.
  let parsed: ViabilityOutputT;
  try {
    parsed = ViabilityOutput.parse(extractJson(finalText));
  } catch (e) {
    return fail(`output failed validation: ${e instanceof Error ? e.message : String(e)}`, finalText);
  }
  if (parsed.idea_id !== idea.id) runner.notes.push(`model reported idea_id ${parsed.idea_id}; expected ${idea.id}`);

  // 2. URL sourcing. Every URL in the output must have come back from a tool in this call.
  const retrieved = retrievedUrls(trace);
  const sourced = (u: string) => retrieved.set.has(normalizeUrl(u)) || retrieved.text.includes(u.trim());
  const unsourced = [...parsed.unsourced_claims];
  const move = (field: string, u: string) => {
    runner.unsourced_moved.push({ field, url: u });
    unsourced.push(`${field}: ${u} (URL not retrieved in this stage call)`);
  };
  const out: ViabilityOutputT = JSON.parse(JSON.stringify(parsed));
  let checked = 0;
  if (isUrl(out.payer.comparable_url)) {
    checked++;
    if (!sourced(out.payer.comparable_url)) (move("payer.comparable_url", out.payer.comparable_url), (out.payer.comparable_url = NOT_FOUND));
  }
  out.competitors.forEach((c, i) => {
    for (const k of ["url", "pricing_url"] as const) {
      if (isUrl(c[k])) {
        checked++;
        if (!sourced(c[k]!)) (move(`competitors[${i}].${k}`, c[k]!), (c[k] = null));
      }
    }
  });
  out.acquisition_channel.forEach((a, i) => {
    if (isUrl(a.source_url)) {
      checked++;
      if (!sourced(a.source_url)) (move(`acquisition_channel[${i}].source_url`, a.source_url), (a.source_url = null));
    }
  });
  out.demand_evidence.forEach((d, i) => {
    if (isUrl(d.url)) {
      checked++;
      if (!sourced(d.url)) (move(`demand_evidence[${i}].url`, d.url), (d.url = null));
    }
  });
  out.regulatory_setup?.obligations.forEach((o, i) => {
    if (isUrl(o.source_url)) {
      checked++;
      if (!sourced(o.source_url)) (move(`regulatory_setup.obligations[${i}].source_url`, o.source_url), (o.source_url = null));
    }
  });
  for (const m of out.brief_md.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    const u = m[0].replace(/[.,;:]+$/, "");
    checked++;
    if (!sourced(u) && !runner.unsourced_moved.some((x) => x.url === u)) move("brief_md", u);
  }
  trace.add("runner_check", { check: "url_sourcing", checked, retrieved: retrieved.set.size, unsourced: runner.unsourced_moved });
  if (runner.unsourced_moved.length) trace.add("runner_override", { kind: "unsourced_url_moved", moved: runner.unsourced_moved });
  out.unsourced_claims = unsourced;

  // Injection scan.
  const detected = scanForInjection(retrieved.text);
  const missed = detected.filter((snippet) => !out.injection_seen.some((s) => snippet.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(snippet.toLowerCase())));
  if (detected.length) trace.add("runner_check", { check: "injection_scan", detected, reported_by_model: parsed.injection_seen, added_by_runner: missed });
  out.injection_seen = [...out.injection_seen, ...missed.map((m) => `[runner-detected] ${m}`)];

  // 3. Completeness. Required fields present and none NOT FOUND.
  const missing: string[] = [];
  if (!present(out.payer.comparable_url) || !isUrl(out.payer.comparable_url)) missing.push("payer.comparable_url");
  const namedCompetitor = out.competitors.some((c) => present(c.name) && isUrl(c.url) && present(c.pricing));
  if (!namedCompetitor && out.competitors_not_found_queries.length < 3) missing.push("competitors (a named competitor with pricing and URL, or 3+ not-found queries)");
  if (!out.acquisition_channel.some((a) => present(a.channel) && present(a.cost_estimate) && isUrl(a.source_url))) missing.push("acquisition_channel");
  if (!out.demand_evidence.some((d) => present(d.quote) && isUrl(d.url))) missing.push("demand_evidence");
  if (!present(out.case_for)) missing.push("case_for");
  if (!present(out.case_against)) missing.push("case_against");
  runner.missing = missing;
  trace.add("runner_check", { check: "completeness", missing, ok: missing.length === 0 });
  const verdict: ViabilityRunResult["verdict"] = missing.length === 0 ? "complete" : "fail_evidence";

  return record(verdict, { ...out, verdict, runner });
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
    if (tu.name === "fetch_page") {
      const input = FetchInput.parse(tu.input);
      const r = await search.fetch_page(input.url);
      return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(r) };
    }
    return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: `unknown tool ${tu.name}` };
  } catch (e) {
    return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: `${tu.name} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
