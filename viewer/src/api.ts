// Typed fetch helpers over viewer/server.ts. Types mirror the server's shaping functions.
import { useEffect, useState } from "react";

export type Stage = "kill_gate" | "viability" | "critic";
export type Json = Record<string, unknown>;

export interface Idea {
  id: string;
  parent_id: string | null;
  idea: string;
  customer: string | null;
  source_url: string | null;
  verbatim_quote: string | null;
  status?: string;
}

export interface RunSummary {
  id: string;
  stages: Stage[];
  config: Json & { models?: Record<string, string>; prompt_hashes?: Record<string, string>; search_mode?: string; model_mode?: string; idea_ids?: string[] };
  budget_usd: number;
  spent_usd: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  superseded_by: string[];
  supersedes: string[];
  tasks: Record<string, number>;
  verdicts: Partial<Record<Stage, Record<string, number>>>;
  result_cost: Partial<Record<Stage, number>>;
}

export interface ResultSummary {
  id: string;
  run_id: string;
  idea_id: string;
  stage: Stage;
  verdict: string;
  rules_fired: string[];
  self_found: number;
  model: string;
  agent: string;
  prompt_hash: string;
  cost_usd: number;
  created_at: string;
  has_doc: boolean;
  kind: string | null;
  rank: number | null;
  annotations: number;
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
  comparison_ids: number[];
  stage_result_id: string;
}

export interface Comparison {
  id: number;
  run_id: string;
  round: number;
  idea_a: string;
  idea_b: string;
  order_ab: "A" | "B";
  order_ba: "A" | "B";
  result: "A" | "B" | "tie";
  rationale: { ab?: { winner?: string; reasons?: string[] }; ba?: { winner?: string; reasons?: string[] } } | null;
  model: string;
  stage_result_id: string | null;
  created_at: string;
  flip: boolean;
  annotations: number;
}

export interface PipelineCell {
  id: string;
  run_id: string;
  verdict: string;
  created_at: string;
  attempts: number;
  cost: number;
  rules_fired: string[];
  rank: number | null;
  score: number | null;
  record: { wins: number; ties: number; losses: number } | null;
  comparisons: number | null;
}

export interface PipelineRow {
  idea: Idea & { status: string };
  kill_gate: PipelineCell | null;
  viability: PipelineCell | null;
  critic: PipelineCell | null;
  annotations: number;
}

export interface TraceEvent {
  id: number;
  seq: number;
  kind: string;
  content: unknown;
  created_at: string;
}

export interface Source {
  key: string;
  url: string;
  title: string | null;
  via: { tool: string; query: string }[];
}

export interface Annotation {
  id: number;
  stage_result_id: string | null;
  comparison_id: number | null;
  idea_id: string | null;
  verdict: "agree" | "disagree" | "unsure" | null;
  note: string;
  failure_mode: string | null;
  blind: number;
  author: string;
  created_at: string;
  target?:
    | { type: "stage_result"; stage: Stage; verdict: string; run_id: string; idea_id: string }
    | { type: "comparison"; run_id: string; round: number; idea_a: string; idea_b: string; result: string }
    | null;
}

export interface StageResultDetail {
  result: ResultSummary & { payload: Json | null; doc_md: string | null };
  idea: Idea | null;
  run: { id: string; status: string } | null;
  events: TraceEvent[];
  kinds: Record<string, number>;
  usage: { calls: number; input: number; output: number; cache_read: number; cache_write: number; cost: number };
  sources: Source[];
  unsourced_doc_urls: string[];
  comparison: (Comparison & { idea_a: Idea | null; idea_b: Idea | null }) | null;
  annotations: Annotation[];
}

export interface HiddenFields {
  seed_source: string | null;
  set_name: string | null;
  test_role: string | null;
  notes: string | null;
  labels: { labeler: string; value: string; reason: string | null; note: string | null; created_at: string }[];
  outcome: { outcome: string; bucket: string; business_name: string | null } | null;
}

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body as T;
}

export async function send<T>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error ?? r.statusText);
  return out as T;
}

export function useGet<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setError(null);
    get<T>(path).then((d) => live && setData(d)).catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export const usd = (n: number | null | undefined, digits = 3) => (n === null || n === undefined ? "" : `$${n.toFixed(digits)}`);
export const short = (s: string | null | undefined, n = 8) => (s ? s.slice(0, n) : "");
export const num = (n: number | null | undefined) => (n === null || n === undefined ? "" : n.toLocaleString());

export function duration(start: string, end: string | null): string {
  if (!end) return "";
  const ms = Date.parse(end.replace(" ", "T") + "Z") - Date.parse(start.replace(" ", "T") + "Z");
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}
