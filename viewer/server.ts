// Local review app for the factory. One process: Vite (dev middleware) for the React front end plus a
// small JSON API over the store. Reads go through a read-only connection; the only writes are
// annotations, through Db.addAnnotation / deleteAnnotation on a second connection.
//   npm run viewer   -> http://localhost:4477
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createServer as createVite } from "vite";
import { Db, openDb, StoreError, type AnnotationRow, type ComparisonDbRow, type RunRow, type StageResultRow } from "../src/store/db.js";
import { PATHS, type Stage } from "../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VIEWER_PORT ?? 4477);

// Open the writable connection first so pending migrations (006 adds the annotation columns) apply,
// then a read-only connection for everything else.
const writer = openDb(PATHS.db);
const readRaw = new Database(PATHS.db, { readonly: true, fileMustExist: true });
readRaw.pragma("busy_timeout = 10000");
const db = new Db(readRaw);

// ---------- shaping ----------

type Json = Record<string, unknown>;
const parse = (s: string | null | undefined): unknown => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

interface RunSummary extends Omit<RunRow, "stages" | "config_json"> {
  stages: Stage[];
  config: Json;
  superseded_by: string[];
  supersedes: string[];
  tasks: Record<string, number>;
  verdicts: Partial<Record<Stage, Record<string, number>>>;
  result_cost: Partial<Record<Stage, number>>;
}

function runSummaries(): RunSummary[] {
  const runs = db.listRuns();
  const supersedes = new Map<string, string[]>();
  const parsed = runs.map((r) => {
    const config = (parse(r.config_json) ?? {}) as Json;
    const by = Array.isArray(config.superseded_by) ? (config.superseded_by as string[]) : [];
    for (const s of by) supersedes.set(s, [...(supersedes.get(s) ?? []), r.id]);
    return { r, config, by };
  });
  return parsed.map(({ r, config, by }) => {
    const verdicts: RunSummary["verdicts"] = {};
    const result_cost: RunSummary["result_cost"] = {};
    for (const sr of db.listStageResults({ runId: r.id })) {
      const v = (verdicts[sr.stage] ??= {});
      v[sr.verdict] = (v[sr.verdict] ?? 0) + 1;
      result_cost[sr.stage] = (result_cost[sr.stage] ?? 0) + sr.cost_usd;
    }
    const { stages, config_json, ...rest } = r;
    void config_json;
    return { ...rest, stages: (parse(stages) as Stage[]) ?? [], config, superseded_by: by, supersedes: supersedes.get(r.id) ?? [], tasks: db.taskCounts(r.id), verdicts, result_cost };
  });
}

function summary(sr: StageResultRow, annotationCounts?: Map<string, number>) {
  const { payload_json, doc_md, ...rest } = sr;
  const payload = parse(payload_json) as Json | null;
  return {
    ...rest,
    rules_fired: (parse(sr.rules_fired) as string[] | null) ?? [],
    has_doc: !!doc_md,
    kind: payload?.kind ?? null, // critic rows: comparison | standing
    rank: typeof payload?.rank === "number" ? (payload.rank as number) : null,
    annotations: annotationCounts?.get(sr.id) ?? db.listAnnotations({ stageResultId: sr.id }).length,
  };
}

function comparisonOut(c: ComparisonDbRow) {
  const { rationale_json, ...rest } = c;
  return { ...rest, rationale: parse(rationale_json), flip: c.order_ab !== c.order_ba, annotations: db.listAnnotations({ comparisonId: c.id }).length };
}

/** Latest result per (idea, stage) over a set of runs (all runs when empty). Critic standings are kept per idea too. */
function latestByIdeaStage(runIds: string[]) {
  const rows = runIds.length ? runIds.flatMap((id) => db.listStageResults({ runId: id })) : db.listStageResults();
  const latest = new Map<string, StageResultRow>();
  const attempts = new Map<string, number>();
  const cost = new Map<string, number>();
  for (const r of rows) {
    const payload = r.stage === "critic" ? (parse(r.payload_json) as Json | null) : null;
    if (r.stage === "critic" && payload?.kind !== "standing") continue;
    const k = `${r.idea_id}|${r.stage}`;
    attempts.set(k, (attempts.get(k) ?? 0) + 1);
    cost.set(k, (cost.get(k) ?? 0) + r.cost_usd);
    const prev = latest.get(k);
    if (!prev || r.created_at > prev.created_at || (r.created_at === prev.created_at && r.id > prev.id)) latest.set(k, r);
  }
  return { latest, attempts, cost, rows };
}

function pipeline(runIds: string[]) {
  const { latest, attempts, cost, rows } = latestByIdeaStage(runIds);
  const criticRows = rows.filter((r) => r.stage === "critic");
  const criticCost = new Map<string, number>();
  const comparisonsPerIdea = new Map<string, number>();
  for (const r of criticRows) {
    const p = parse(r.payload_json) as Json | null;
    if (p?.kind !== "comparison") continue;
    for (const id of [p.idea_a, p.idea_b] as string[]) {
      criticCost.set(id, (criticCost.get(id) ?? 0) + r.cost_usd / 2);
      comparisonsPerIdea.set(id, (comparisonsPerIdea.get(id) ?? 0) + 1);
    }
  }
  const annotationsByIdea = new Map<string, number>();
  for (const a of db.listAnnotations()) if (a.idea_id) annotationsByIdea.set(a.idea_id, (annotationsByIdea.get(a.idea_id) ?? 0) + 1);
  return db.listIdeasWithStatus().map((idea) => {
    const cell = (stage: Stage) => {
      const k = `${idea.id}|${stage}`;
      const r = latest.get(k);
      if (!r) return null;
      const payload = parse(r.payload_json) as Json | null;
      return {
        id: r.id,
        run_id: r.run_id,
        verdict: r.verdict,
        created_at: r.created_at,
        attempts: attempts.get(k) ?? 0,
        cost: stage === "critic" ? (criticCost.get(idea.id) ?? 0) : (cost.get(k) ?? 0),
        rules_fired: (parse(r.rules_fired) as string[] | null) ?? [],
        rank: stage === "critic" && typeof payload?.rank === "number" ? (payload.rank as number) : null,
        score: stage === "critic" && typeof payload?.score === "number" ? (payload.score as number) : null,
        record: stage === "critic" && payload ? { wins: payload.wins, ties: payload.ties, losses: payload.losses } : null,
        comparisons: stage === "critic" ? (comparisonsPerIdea.get(idea.id) ?? 0) : null,
      };
    };
    return { idea, kill_gate: cell("kill_gate"), viability: cell("viability"), critic: cell("critic"), annotations: annotationsByIdea.get(idea.id) ?? 0 };
  });
}

const normUrl = (u: string) => {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch {
    return u.trim().replace(/\/+$/, "");
  }
};

/** URLs the stage actually retrieved, from its tool_result events, with where each came from. */
function sourcesFromEvents(events: { kind: string; content: unknown }[]) {
  const out = new Map<string, { url: string; title: string | null; via: { tool: string; query: string }[] }>();
  const add = (url: unknown, title: unknown, tool: string, query: string) => {
    if (typeof url !== "string" || !url) return;
    const k = normUrl(url);
    const e = out.get(k) ?? { url, title: null, via: [] };
    if (!e.title && typeof title === "string" && title) e.title = title;
    e.via.push({ tool, query });
    out.set(k, e);
  };
  for (const ev of events) {
    if (ev.kind !== "tool_result") continue;
    const c = ev.content as Json;
    const tool = String(c.tool ?? "");
    const query = String(c.query ?? "");
    const result = c.result as Json | undefined;
    if (!result) continue;
    if (Array.isArray(result.results)) for (const r of result.results as Json[]) add(r.url, r.title, tool, query);
    else add(result.url, result.title, tool, query);
  }
  return [...out.entries()].map(([key, v]) => ({ key, ...v }));
}

function stageResultDetail(id: string) {
  const sr = db.getStageResult(id);
  if (!sr) return null;
  const events = db.getTraceEvents(id);
  const payload = parse(sr.payload_json) as Json | null;
  const sources = sourcesFromEvents(events);
  const sourceKeys = new Set(sources.map((s) => s.key));
  const docUrls = [...new Set([...(sr.doc_md ?? "").matchAll(/https?:\/\/[^\s)\]>"'`]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))];
  const unsourced_doc_urls = docUrls.filter((u) => !sourceKeys.has(normUrl(u)));
  let comparison = null;
  if (sr.stage === "critic" && payload?.kind === "comparison") {
    const c = db.listComparisons({ runId: sr.run_id }).find((x) => x.stage_result_id === sr.id);
    if (c) comparison = { ...comparisonOut(c), idea_a: db.getAgentSafeIdea(c.idea_a), idea_b: db.getAgentSafeIdea(c.idea_b) };
  }
  const usage = events
    .filter((e) => e.kind === "model_call")
    .reduce(
      (a, e) => {
        const u = ((e.content as Json).usage ?? {}) as Record<string, number>;
        a.calls++;
        a.input += u.input_tokens ?? 0;
        a.output += u.output_tokens ?? 0;
        a.cache_read += u.cache_read_input_tokens ?? 0;
        a.cache_write += u.cache_creation_input_tokens ?? 0;
        a.cost += Number((e.content as Json).cost_usd ?? 0);
        return a;
      },
      { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 },
    );
  const kinds: Record<string, number> = {};
  for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  return {
    result: { ...summary(sr), payload, doc_md: sr.doc_md },
    idea: db.getAgentSafeIdea(sr.idea_id),
    run: db.getRun(sr.run_id),
    events,
    kinds,
    usage,
    sources,
    unsourced_doc_urls,
    comparison,
    annotations: db.listAnnotations({ stageResultId: id }),
  };
}

function annotationContext(a: AnnotationRow) {
  const sr = a.stage_result_id ? db.getStageResult(a.stage_result_id) : null;
  const cmp = a.comparison_id !== null ? db.getComparison(a.comparison_id) : null;
  return {
    ...a,
    target: sr
      ? { type: "stage_result", stage: sr.stage, verdict: sr.verdict, run_id: sr.run_id, idea_id: sr.idea_id }
      : cmp
        ? { type: "comparison", run_id: cmp.run_id, round: cmp.round, idea_a: cmp.idea_a, idea_b: cmp.idea_b, result: cmp.result }
        : null,
  };
}

// ---------- http ----------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(s ? (JSON.parse(s) as Json) : {});
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function api(method: string, url: URL, req: http.IncomingMessage): Promise<unknown> {
  const p = url.pathname.replace(/^\/api/, "");
  const seg = p.split("/").filter(Boolean);
  const m = (pattern: string) => {
    const ps = pattern.split("/").filter(Boolean);
    if (ps.length !== seg.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(seg[i]);
      else if (ps[i] !== seg[i]) return null;
    }
    return params;
  };
  let x: Record<string, string> | null;

  if (method === "GET") {
    if (m("/runs")) return runSummaries();
    if ((x = m("/runs/:id"))) {
      const run = runSummaries().find((r) => r.id === x!.id);
      if (!run) throw new HttpError(404, `run ${x.id} not found`);
      const results = db.listStageResults({ runId: run.id }).map((sr) => summary(sr));
      const standings = db
        .listStageResults({ runId: run.id, stage: "critic" })
        .map((sr) => ({ sr, payload: parse(sr.payload_json) as Json | null }))
        .filter((r) => r.payload?.kind === "standing")
        .map((r) => ({ ...r.payload, stage_result_id: r.sr.id }))
        .sort((a, b) => Number((a as Json).rank) - Number((b as Json).rank));
      return { run, results, standings, tasks: db.listTasks(run.id) };
    }
    if ((x = m("/runs/:id/critic"))) {
      const run = db.getRun(x.id);
      if (!run) throw new HttpError(404, `run ${x.id} not found`);
      const standings = db
        .listStageResults({ runId: run.id, stage: "critic" })
        .map((sr) => ({ sr, payload: parse(sr.payload_json) as Json | null }))
        .filter((r) => r.payload?.kind === "standing")
        .map((r) => ({ ...r.payload, stage_result_id: r.sr.id }))
        .sort((a, b) => Number((a as Json).rank) - Number((b as Json).rank));
      const comparisons = db.listComparisons({ runId: run.id }).map(comparisonOut);
      const ideaIds = [...new Set(comparisons.flatMap((c) => [c.idea_a, c.idea_b]))];
      const ideas = Object.fromEntries(ideaIds.map((id) => [id, db.getAgentSafeIdea(id)]));
      return { run, standings, comparisons, ideas };
    }
    if (m("/pipeline")) {
      const runs = (url.searchParams.get("run") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return { runs, rows: pipeline(runs) };
    }
    if ((x = m("/ideas/:id"))) {
      const idea = db.listIdeasWithStatus().find((i) => i.id === x!.id);
      if (!idea) throw new HttpError(404, `idea ${x.id} not found`);
      const results = db.listStageResults({ ideaId: idea.id }).map((sr) => summary(sr));
      const comparisons = db.listComparisons({ ideaId: idea.id }).map(comparisonOut);
      const variants = db.listIdeasWithStatus().filter((i) => i.parent_id === idea.id);
      const parent = idea.parent_id ? db.getAgentSafeIdea(idea.parent_id) : null;
      return { idea, parent, variants, results, comparisons, annotations: db.listAnnotations({ ideaId: idea.id }).map(annotationContext) };
    }
    if ((x = m("/ideas/:id/reveal"))) {
      // The one path that returns hidden fields. Only the UI's explicit reveal toggle calls it.
      const hidden = db.revealIdea(x.id);
      if (!hidden) throw new HttpError(404, `idea ${x.id} not found`);
      return hidden;
    }
    if ((x = m("/stage-results/:id"))) {
      const d = stageResultDetail(x.id);
      if (!d) throw new HttpError(404, `stage result ${x.id} not found`);
      return d;
    }
    if ((x = m("/comparisons/:id"))) {
      const c = db.getComparison(Number(x.id));
      if (!c) throw new HttpError(404, `comparison ${x.id} not found`);
      return { ...comparisonOut(c), idea_a: db.getAgentSafeIdea(c.idea_a), idea_b: db.getAgentSafeIdea(c.idea_b), annotations: db.listAnnotations({ comparisonId: c.id }) };
    }
    if (m("/annotations")) return db.listAnnotations().map(annotationContext);
    if (m("/search")) {
      // Deep-link resolver: an id of any kind -> where it lives.
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return null;
      if (db.getStageResult(q)) return { type: "stage_result", id: q };
      if (db.getRun(q)) return { type: "run", id: q };
      if (db.getAgentSafeIdea(q)) return { type: "idea", id: q };
      if (/^\d+$/.test(q) && db.getComparison(Number(q))) return { type: "comparison", id: q };
      return null;
    }
  }
  if (method === "POST" && m("/annotations")) {
    const b = await readBody(req);
    try {
      return writer.addAnnotation({
        stageResultId: typeof b.stage_result_id === "string" ? b.stage_result_id : null,
        comparisonId: typeof b.comparison_id === "number" ? b.comparison_id : null,
        ideaId: typeof b.idea_id === "string" ? b.idea_id : null,
        verdict: (b.verdict as "agree" | "disagree" | "unsure" | null | undefined) ?? null,
        note: typeof b.note === "string" ? b.note : "",
        blind: b.blind !== false,
      });
    } catch (e) {
      if (e instanceof StoreError) throw new HttpError(400, e.message);
      throw e;
    }
  }
  if (method === "DELETE" && (x = m("/annotations/:id"))) {
    if (!writer.deleteAnnotation(Number(x.id))) throw new HttpError(404, `annotation ${x.id} not found`);
    return { ok: true };
  }
  throw new HttpError(404, `no route ${method} ${p}`);
}

const vite = await createVite({ root: here, configFile: path.join(here, "vite.config.ts"), server: { middlewareMode: true }, appType: "spa" });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/api/")) return vite.middlewares(req, res);
  try {
    const body = await api(req.method ?? "GET", url, req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`viewer: http://localhost:${PORT}  (store ${PATHS.db})`);
});

const shutdown = () => {
  server.close();
  void vite.close();
  db.close();
  writer.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
