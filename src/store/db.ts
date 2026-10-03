import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { PATHS, type Stage } from "../config.js";

// Hidden idea columns. Never returned by any agent-facing path.
export const HIDDEN_IDEA_FIELDS = ["seed_source", "set_name", "test_role", "notes"] as const;

export interface AgentSafeIdea {
  id: string;
  parent_id: string | null;
  idea: string;
  customer: string | null;
  source_url: string | null;
  verbatim_quote: string | null;
}

/** The only view of an idea that agents, prompts, MCP read tools and exports may see. */
export function agentSafeIdea(row: Record<string, unknown>): AgentSafeIdea {
  return {
    id: String(row.id),
    parent_id: (row.parent_id as string | null) ?? null,
    idea: String(row.idea),
    customer: (row.customer as string | null) ?? null,
    source_url: (row.source_url as string | null) ?? null,
    verbatim_quote: (row.verbatim_quote as string | null) ?? null,
  };
}

export interface RuleRow {
  id: string;
  kind: "kill_rule" | "hard_test" | "soft_test";
  text: string;
  test_case_ids: string | null;
  status: "proposed" | "active" | "retired";
  proposed_by: string | null;
  source_run_id: string | null;
  activated_at: string | null;
  created_at: string;
}

/** Rule fields agents may see. test_case_ids names planted ideas, so it stays out of prompts. */
export interface AgentSafeRule {
  id: string;
  kind: RuleRow["kind"];
  text: string;
}

export interface TaskRow {
  id: string;
  run_id: string;
  idea_id: string | null;
  stage: Stage;
  claimed_by: string | null;
  claimed_at: string | null;
  status: "open" | "claimed" | "done" | "error" | "cancelled";
}

export interface RunRow {
  id: string;
  stages: string;
  config_json: string;
  budget_usd: number;
  spent_usd: number;
  status: "running" | "complete" | "budget_exceeded" | "error" | "paused" | "superseded";
  started_at: string;
  finished_at: string | null;
}

export interface StageResultRow {
  id: string;
  run_id: string;
  idea_id: string;
  stage: Stage;
  verdict: string;
  payload_json: string;
  doc_md: string | null;
  rules_fired: string | null;
  self_found: number;
  model: string;
  agent: string;
  prompt_hash: string;
  cost_usd: number;
  created_at: string;
}

export interface TraceEventInput {
  kind: string;
  content: unknown;
}

export interface TraceEventRow {
  id: number;
  stage_result_id: string;
  seq: number;
  kind: string;
  content: unknown;
  created_at: string;
}

export interface ComparisonDbRow {
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

export type AnnotationVerdict = "agree" | "disagree" | "unsure";

export interface AnnotationRow {
  id: number;
  stage_result_id: string | null;
  comparison_id: number | null;
  idea_id: string | null;
  verdict: AnnotationVerdict | null;
  note: string;
  failure_mode: string | null;
  blind: number;
  author: string;
  created_at: string;
}

export interface AddAnnotationInput {
  stageResultId?: string | null;
  comparisonId?: number | null;
  ideaId?: string | null;
  verdict?: AnnotationVerdict | null;
  note?: string;
  blind: boolean;
  author?: string;
}

/** Everything hidden from agents about one idea. Only the review app's explicit reveal path reads this. */
export interface HiddenIdeaFields {
  seed_source: string | null;
  set_name: string | null;
  test_role: string | null;
  notes: string | null;
  labels: { labeler: string; value: string; reason: string | null; note: string | null; created_at: string }[];
  outcome: { outcome: string; bucket: string; business_name: string | null } | null;
}

export interface RecordStageResultInput {
  runId: string;
  ideaId: string;
  stage: Stage;
  verdict: string;
  payload: unknown;
  docMd?: string | null;
  rulesFired?: string[];
  selfFound?: boolean;
  model: string;
  agent: string;
  promptHash: string;
  costUsd: number;
  events: TraceEventInput[];
  taskId?: string | null;
}

export class StoreError extends Error {}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export class Db {
  readonly raw: Database.Database;

  constructor(raw: Database.Database) {
    this.raw = raw;
  }

  close(): void {
    this.raw.close();
  }

  // ---------- ideas ----------

  countIdeas(): number {
    return (this.raw.prepare("SELECT COUNT(*) AS n FROM ideas").get() as { n: number }).n;
  }

  getAgentSafeIdea(id: string): AgentSafeIdea | null {
    const row = this.raw.prepare("SELECT id, parent_id, idea, customer, source_url, verbatim_quote FROM ideas WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? agentSafeIdea(row) : null;
  }

  listAgentSafeIdeas(): AgentSafeIdea[] {
    const rows = this.raw.prepare("SELECT id, parent_id, idea, customer, source_url, verbatim_quote FROM ideas ORDER BY id").all() as Record<string, unknown>[];
    return rows.map(agentSafeIdea);
  }

  /** Ids of ideas with status active. Live runs select these only. */
  activeIdeaIds(): string[] {
    return (this.raw.prepare("SELECT id FROM ideas WHERE status = 'active' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  }

  getIdeaStatus(id: string): string | null {
    return (this.raw.prepare("SELECT status FROM ideas WHERE id = ?").get(id) as { status: string } | undefined)?.status ?? null;
  }

  /** Paul only (npm run variant:promote). Moves a proposed or archived variant to active. */
  setIdeaStatus(id: string, status: "active" | "proposed_variant" | "archived"): void {
    const r = this.raw.prepare("UPDATE ideas SET status = ? WHERE id = ?").run(status, id);
    if (r.changes !== 1) throw new StoreError(`idea ${id} not found`);
  }

  /** Latest verdict per stage for every idea: { ideaId: { kill_gate: 'pass', ... } }. */
  latestVerdicts(): Record<string, Partial<Record<Stage, string>>> {
    const rows = this.raw
      .prepare(
        `SELECT idea_id, stage, verdict FROM stage_results sr
         WHERE created_at = (SELECT MAX(created_at) FROM stage_results s2 WHERE s2.idea_id = sr.idea_id AND s2.stage = sr.stage)
           AND id = (SELECT id FROM stage_results s3 WHERE s3.idea_id = sr.idea_id AND s3.stage = sr.stage ORDER BY created_at DESC, rowid DESC LIMIT 1)`,
      )
      .all() as { idea_id: string; stage: Stage; verdict: string }[];
    const out: Record<string, Partial<Record<Stage, string>>> = {};
    for (const r of rows) (out[r.idea_id] ??= {})[r.stage] = r.verdict;
    return out;
  }

  private nextIdeaId(): string {
    const rows = this.raw.prepare("SELECT id FROM ideas WHERE id GLOB 'I[0-9][0-9][0-9][0-9]*'").all() as { id: string }[];
    let max = 0;
    for (const r of rows) {
      const n = Number(r.id.slice(1));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `I${String(max + 1).padStart(4, "0")}`;
  }

  /**
   * Insert an idea. seed_source is 'agent_variant' when parent_id is set. If an identical variant
   * (same parent and text) already exists, it is returned instead of duplicated.
   */
  createIdea(input: { idea: string; customer?: string | null; source_url?: string | null; verbatim_quote?: string | null; parent_id?: string | null; id?: string }): AgentSafeIdea {
    const tx = this.raw.transaction(() => {
      if (input.parent_id) {
        const parent = this.raw.prepare("SELECT id FROM ideas WHERE id = ?").get(input.parent_id);
        if (!parent) throw new StoreError(`parent idea ${input.parent_id} does not exist`);
        const existing = this.raw.prepare("SELECT id FROM ideas WHERE parent_id = ? AND idea = ?").get(input.parent_id, input.idea) as { id: string } | undefined;
        if (existing) return existing.id;
      }
      const id = input.id ?? this.nextIdeaId();
      this.raw
        .prepare("INSERT INTO ideas (id, parent_id, idea, customer, source_url, verbatim_quote, seed_source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.parent_id ?? null, input.idea, input.customer ?? null, input.source_url ?? null, input.verbatim_quote ?? null, input.parent_id ? "agent_variant" : null, input.parent_id ? "proposed_variant" : "active");
      return id;
    });
    const id = tx.immediate();
    return this.getAgentSafeIdea(id)!;
  }

  // ---------- rules ----------

  listRules(status?: RuleRow["status"]): RuleRow[] {
    if (status) return this.raw.prepare("SELECT * FROM rules WHERE status = ? ORDER BY id").all(status) as RuleRow[];
    return this.raw.prepare("SELECT * FROM rules ORDER BY id").all() as RuleRow[];
  }

  agentSafeRules(status?: RuleRow["status"]): (AgentSafeRule & { status: RuleRow["status"] })[] {
    return this.listRules(status).map((r) => ({ id: r.id, kind: r.kind, text: r.text, status: r.status }));
  }

  /** Active rules, agent-safe. The only rules stage prompts receive. */
  activeRules(): AgentSafeRule[] {
    return this.listRules("active").map((r) => ({ id: r.id, kind: r.kind, text: r.text }));
  }

  proposeRule(input: { kind: RuleRow["kind"]; text: string; test_case_ids: { must_trigger?: string[]; must_not_trigger?: string[] }; proposed_by: string; source_run_id?: string | null; id?: string }): RuleRow {
    const ids = input.test_case_ids ?? {};
    const all = [...(ids.must_trigger ?? []), ...(ids.must_not_trigger ?? [])];
    if (all.length === 0) throw new StoreError("propose_rule requires test_case_ids with at least one idea id");
    for (const id of all) {
      if (!this.raw.prepare("SELECT 1 FROM ideas WHERE id = ?").get(id)) throw new StoreError(`test case idea ${id} does not exist`);
    }
    const id = input.id ?? this.nextRuleId(input.kind);
    this.raw
      .prepare("INSERT INTO rules (id, kind, text, test_case_ids, status, proposed_by, source_run_id) VALUES (?, ?, ?, ?, 'proposed', ?, ?)")
      .run(id, input.kind, input.text, JSON.stringify({ must_trigger: ids.must_trigger ?? [], must_not_trigger: ids.must_not_trigger ?? [] }), input.proposed_by, input.source_run_id ?? null);
    return this.raw.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow;
  }

  private nextRuleId(kind: RuleRow["kind"]): string {
    const prefix = kind === "kill_rule" ? "R" : "T";
    const rows = this.raw.prepare("SELECT id FROM rules WHERE id LIKE ?").all(`${prefix}%`) as { id: string }[];
    let max = 0;
    for (const r of rows) {
      const n = Number(r.id.slice(1));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return prefix === "R" ? `R${String(max + 1).padStart(3, "0")}` : `T${max + 1}`;
  }

  /** Paul only (npm run rule:activate). */
  activateRule(id: string): RuleRow {
    const r = this.raw.prepare("UPDATE rules SET status = 'active', activated_at = datetime('now') WHERE id = ?").run(id);
    if (r.changes !== 1) throw new StoreError(`rule ${id} not found`);
    return this.raw.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow;
  }

  // ---------- runs and tasks ----------

  createRun(input: { stages: Stage[]; budgetUsd: number; configJson: unknown; id?: string }): RunRow {
    const id = input.id ?? newId("run");
    this.raw
      .prepare("INSERT INTO runs (id, stages, config_json, budget_usd, status) VALUES (?, ?, ?, ?, 'running')")
      .run(id, JSON.stringify(input.stages), JSON.stringify(input.configJson ?? {}), input.budgetUsd);
    return this.getRun(id)!;
  }

  getRun(id: string): RunRow | null {
    return (this.raw.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined) ?? null;
  }

  finishRun(id: string, status: RunRow["status"]): void {
    this.raw.prepare("UPDATE runs SET status = ?, finished_at = datetime('now') WHERE id = ?").run(status, id);
  }

  /** Adds cost to the run and returns the new total. */
  addSpend(runId: string, usd: number): number {
    this.raw.prepare("UPDATE runs SET spent_usd = spent_usd + ? WHERE id = ?").run(usd, runId);
    return this.getRun(runId)!.spent_usd;
  }

  createTasks(runId: string, stage: Stage, ideaIds: string[]): TaskRow[] {
    const insert = this.raw.prepare("INSERT INTO tasks (id, run_id, idea_id, stage) VALUES (?, ?, ?, ?)");
    const ids: string[] = [];
    this.raw.transaction(() => {
      for (const ideaId of ideaIds) {
        const id = `task_${stage}_${ideaId}_${crypto.randomBytes(4).toString("hex")}`;
        insert.run(id, runId, ideaId, stage);
        ids.push(id);
      }
    })();
    return ids.map((id) => this.getTask(id)!);
  }

  getTask(id: string): TaskRow | null {
    return (this.raw.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined) ?? null;
  }

  listTasks(runId: string, status?: TaskRow["status"]): TaskRow[] {
    if (status) return this.raw.prepare("SELECT * FROM tasks WHERE run_id = ? AND status = ? ORDER BY rowid").all(runId, status) as TaskRow[];
    return this.raw.prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid").all(runId) as TaskRow[];
  }

  /** Atomic claim. Succeeds only when the conditional update changes exactly one row. */
  claimTask(taskId: string, claimedBy: string): "claimed" | "already_claimed" | "not_found" {
    const r = this.raw
      .prepare("UPDATE tasks SET claimed_by = ?, claimed_at = datetime('now'), status = 'claimed' WHERE id = ? AND claimed_by IS NULL AND status = 'open'")
      .run(claimedBy, taskId);
    if (r.changes === 1) return "claimed";
    return this.getTask(taskId) ? "already_claimed" : "not_found";
  }

  /**
   * Retire a run that a later run superseded: cancels its open tasks (so claimTask can never hand them out)
   * and marks the run superseded. Claimed, done and error tasks are left as history. Returns the cancelled count.
   */
  supersedeRun(runId: string, supersededBy: string[]): number {
    if (!this.getRun(runId)) throw new StoreError(`run ${runId} does not exist`);
    return this.raw.transaction(() => {
      const r = this.raw.prepare("UPDATE tasks SET status = 'cancelled' WHERE run_id = ? AND status = 'open'").run(runId);
      this.raw.prepare("UPDATE runs SET status = 'superseded', finished_at = COALESCE(finished_at, datetime('now')) WHERE id = ?").run(runId);
      this.raw.prepare("UPDATE runs SET config_json = json_set(config_json, '$.superseded_by', json(?)) WHERE id = ?").run(JSON.stringify(supersededBy), runId);
      return r.changes;
    })();
  }

  setTaskStatus(taskId: string, status: TaskRow["status"]): void {
    this.raw.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);
  }

  // ---------- stage results and traces ----------

  /**
   * Write a stage result and its trace events in one transaction. A result without trace events
   * is invalid and rejected (critical rule 7). Marks the task done when taskId is given.
   */
  recordStageResult(input: RecordStageResultInput): StageResultRow {
    if (!input.events || input.events.length === 0) throw new StoreError("stage result rejected: no trace events");
    if (!this.raw.prepare("SELECT 1 FROM runs WHERE id = ?").get(input.runId)) throw new StoreError(`run ${input.runId} does not exist`);
    if (!this.raw.prepare("SELECT 1 FROM ideas WHERE id = ?").get(input.ideaId)) throw new StoreError(`idea ${input.ideaId} does not exist`);
    const id = newId("sr");
    const insertResult = this.raw.prepare(
      `INSERT INTO stage_results (id, run_id, idea_id, stage, verdict, payload_json, doc_md, rules_fired, self_found, model, agent, prompt_hash, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = this.raw.prepare("INSERT INTO trace_events (stage_result_id, seq, kind, content_json) VALUES (?, ?, ?, ?)");
    this.raw.transaction(() => {
      insertResult.run(
        id, input.runId, input.ideaId, input.stage, input.verdict, JSON.stringify(input.payload ?? {}), input.docMd ?? null,
        JSON.stringify(input.rulesFired ?? []), input.selfFound ? 1 : 0, input.model, input.agent, input.promptHash, input.costUsd ?? 0,
      );
      input.events.forEach((e, i) => insertEvent.run(id, i + 1, e.kind, JSON.stringify(e.content ?? null)));
      if (input.taskId) this.raw.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(input.verdict === "error" ? "error" : "done", input.taskId);
      this.raw.prepare("UPDATE runs SET spent_usd = spent_usd + ? WHERE id = ?").run(input.costUsd ?? 0, input.runId);
    })();
    return this.getStageResult(id)!;
  }

  getStageResult(id: string): StageResultRow | null {
    return (this.raw.prepare("SELECT * FROM stage_results WHERE id = ?").get(id) as StageResultRow | undefined) ?? null;
  }

  latestStageResult(ideaId: string, stage: Stage): StageResultRow | null {
    return (this.raw.prepare("SELECT * FROM stage_results WHERE idea_id = ? AND stage = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(ideaId, stage) as StageResultRow | undefined) ?? null;
  }

  listStageResults(filter: { runId?: string; stage?: Stage; ideaId?: string } = {}): StageResultRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.runId) (where.push("run_id = ?"), args.push(filter.runId));
    if (filter.stage) (where.push("stage = ?"), args.push(filter.stage));
    if (filter.ideaId) (where.push("idea_id = ?"), args.push(filter.ideaId));
    const sql = `SELECT * FROM stage_results ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, rowid`;
    return this.raw.prepare(sql).all(...args) as StageResultRow[];
  }

  getTraceEvents(stageResultId: string): TraceEventRow[] {
    const rows = this.raw.prepare("SELECT id, stage_result_id, seq, kind, content_json, created_at FROM trace_events WHERE stage_result_id = ? ORDER BY seq").all(stageResultId) as (Omit<TraceEventRow, "content"> & { content_json: string })[];
    return rows.map(({ content_json, ...rest }) => ({ ...rest, content: JSON.parse(content_json) }));
  }

  // ---------- review app (viewer/) reads ----------

  listRuns(): RunRow[] {
    return this.raw.prepare("SELECT * FROM runs ORDER BY started_at, rowid").all() as RunRow[];
  }

  /** Task counts by status for one run: { open: 3, done: 40, ... }. */
  taskCounts(runId: string): Record<string, number> {
    const rows = this.raw.prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE run_id = ? GROUP BY status").all(runId) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Agent-safe ideas plus their lifecycle status (active | proposed_variant | archived). */
  listIdeasWithStatus(): (AgentSafeIdea & { status: string })[] {
    const rows = this.raw.prepare("SELECT id, parent_id, idea, customer, source_url, verbatim_quote, status FROM ideas ORDER BY id").all() as Record<string, unknown>[];
    return rows.map((r) => ({ ...agentSafeIdea(r), status: String(r.status) }));
  }

  listComparisons(filter: { runId?: string; ideaId?: string } = {}): ComparisonDbRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.runId) (where.push("run_id = ?"), args.push(filter.runId));
    if (filter.ideaId) (where.push("(idea_a = ? OR idea_b = ?)"), args.push(filter.ideaId, filter.ideaId));
    const sql = `SELECT * FROM comparisons ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY round, id`;
    return this.raw.prepare(sql).all(...args) as ComparisonDbRow[];
  }

  getComparison(id: number): ComparisonDbRow | null {
    return (this.raw.prepare("SELECT * FROM comparisons WHERE id = ?").get(id) as ComparisonDbRow | undefined) ?? null;
  }

  /**
   * Paul only, behind the review app's explicit "reveal" toggle. Never called from stage code, the MCP
   * server or exports. Returns null when the idea does not exist.
   */
  revealIdea(id: string): HiddenIdeaFields | null {
    const row = this.raw.prepare("SELECT seed_source, set_name, test_role, notes FROM ideas WHERE id = ?").get(id) as Omit<HiddenIdeaFields, "labels" | "outcome"> | undefined;
    if (!row) return null;
    const labels = this.raw.prepare("SELECT labeler, value, reason, note, created_at FROM labels WHERE idea_id = ? ORDER BY id").all(id) as HiddenIdeaFields["labels"];
    const outcome = (this.raw.prepare("SELECT outcome, bucket, business_name FROM outcomes WHERE idea_id = ?").get(id) as HiddenIdeaFields["outcome"] | undefined) ?? null;
    return { ...row, labels, outcome };
  }

  // ---------- annotations (the review app's only writes) ----------

  /**
   * Add an annotation to a stage result or a comparison (exactly one of them). idea_id defaults to the
   * target's idea for stage results. A verdict without a note is allowed; a note without a verdict too.
   */
  addAnnotation(input: AddAnnotationInput): AnnotationRow {
    const hasSr = !!input.stageResultId;
    const hasCmp = input.comparisonId !== null && input.comparisonId !== undefined;
    if (hasSr === hasCmp) throw new StoreError("annotation needs exactly one of stageResultId or comparisonId");
    if (input.verdict && !["agree", "disagree", "unsure"].includes(input.verdict)) throw new StoreError(`invalid verdict ${input.verdict}`);
    const note = (input.note ?? "").trim();
    if (!input.verdict && !note) throw new StoreError("annotation needs a verdict or a note");
    let ideaId = input.ideaId ?? null;
    if (hasSr) {
      const sr = this.getStageResult(input.stageResultId!);
      if (!sr) throw new StoreError(`stage result ${input.stageResultId} does not exist`);
      ideaId ??= sr.idea_id;
    } else if (!this.getComparison(input.comparisonId!)) {
      throw new StoreError(`comparison ${input.comparisonId} does not exist`);
    }
    if (ideaId && !this.raw.prepare("SELECT 1 FROM ideas WHERE id = ?").get(ideaId)) throw new StoreError(`idea ${ideaId} does not exist`);
    const r = this.raw
      .prepare("INSERT INTO annotations (stage_result_id, comparison_id, idea_id, verdict, note, blind, author) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.stageResultId ?? null, hasCmp ? input.comparisonId : null, ideaId, input.verdict ?? null, note, input.blind ? 1 : 0, input.author ?? "paul");
    return this.getAnnotation(Number(r.lastInsertRowid))!;
  }

  getAnnotation(id: number): AnnotationRow | null {
    return (this.raw.prepare("SELECT * FROM annotations WHERE id = ?").get(id) as AnnotationRow | undefined) ?? null;
  }

  listAnnotations(filter: { stageResultId?: string; comparisonId?: number; ideaId?: string } = {}): AnnotationRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.stageResultId) (where.push("stage_result_id = ?"), args.push(filter.stageResultId));
    if (filter.comparisonId !== undefined) (where.push("comparison_id = ?"), args.push(filter.comparisonId));
    if (filter.ideaId) (where.push("idea_id = ?"), args.push(filter.ideaId));
    const sql = `SELECT * FROM annotations ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC`;
    return this.raw.prepare(sql).all(...args) as AnnotationRow[];
  }

  deleteAnnotation(id: number): boolean {
    return this.raw.prepare("DELETE FROM annotations WHERE id = ?").run(id).changes === 1;
  }

  // ---------- backtest contamination check ----------

  /**
   * Does any of these competitor names or URLs match the business a backtest row describes
   * (outcomes.business_name)? The stage runner only ever receives this boolean.
   */
  matchesBacktestBusiness(ideaId: string, competitors: { name: string; url?: string | null }[]): boolean {
    const row = this.raw.prepare("SELECT business_name FROM outcomes WHERE idea_id = ?").get(ideaId) as { business_name: string | null } | undefined;
    if (!row?.business_name) return false;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const business = norm(row.business_name);
    if (business.length < 3) return false;
    for (const c of competitors) {
      const n = norm(c.name ?? "");
      if (n && (n.includes(business) || business.includes(n))) return true;
      if (c.url) {
        try {
          const host = norm(new URL(c.url).hostname.replace(/^www\./, "").split(".")[0]);
          if (host && (host === business || business.includes(host) || host.includes(business))) return true;
        } catch {
          /* not a URL */
        }
      }
    }
    return false;
  }
}

/** Schema version a fresh store is at after schema.sql. Bump when adding migrations/NNN_*.sql. */
export const SCHEMA_VERSION = 6;

/** Migrations for stores created by an earlier schema. 002 is in code; 003+ are SQL files in migrations/. */
function migrate(raw: Database.Database): void {
  let version = raw.pragma("user_version", { simple: true }) as number;
  if (version < 2) {
    const cols = (raw.prepare("PRAGMA table_info(outcomes)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("business_name")) raw.exec("ALTER TABLE outcomes ADD COLUMN business_name TEXT");
    raw.pragma("user_version = 2");
    version = 2;
  }
  const dir = path.join(path.dirname(PATHS.schema), "migrations");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort() : [];
  for (const f of files) {
    const n = Number(f.slice(0, 3));
    if (n <= version) continue;
    raw.transaction(() => {
      raw.exec(fs.readFileSync(path.join(dir, f), "utf8"));
      raw.pragma(`user_version = ${n}`);
    })();
    version = n;
  }
}

/** Open (and migrate if empty) the store. WAL mode so two agents can share it. */
export function openDb(dbPath: string = PATHS.db): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 10000");
  raw.pragma("foreign_keys = ON");
  const hasIdeas = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ideas'").get();
  if (!hasIdeas) {
    const schema = fs.readFileSync(PATHS.schema, "utf8");
    raw.exec(schema);
    raw.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  migrate(raw);
  return new Db(raw);
}
