// Writes traces/traces.jsonl: one object per stage result, with the system prompt, input, events,
// output, verdict and cost. Hidden idea fields, labels and outcomes never appear: every idea reference
// goes through the agent-safe view and the trace events were written by stage code that never saw them.
//   npm run export:traces [-- --run <run id>] [--out traces/traces.jsonl]
import fs from "node:fs";
import path from "node:path";
import { openDb, HIDDEN_IDEA_FIELDS, type Db, type StageResultRow } from "../src/store/db.js";
import { PATHS } from "../src/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = process.argv[i + 1];
  return i >= 0 && v && !v.startsWith("--") ? v : undefined;
}

const FORBIDDEN_KEYS = new Set<string>([...HIDDEN_IDEA_FIELDS, "labels", "outcomes", "label", "outcome", "bucket", "business_name", "paul_gut_v1", "operability_label", "known_outcome"]);

/** Defensive scrub: drop any forbidden key wherever it appears. Stage code should never produce one; this is the belt to that brace. */
export function scrub<T>(value: T, dropped: string[] = []): T {
  if (Array.isArray(value)) return value.map((v) => scrub(v, dropped)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) {
        dropped.push(k);
        continue;
      }
      out[k] = scrub(v, dropped);
    }
    return out as T;
  }
  return value;
}

export function traceObject(db: Db, sr: StageResultRow, dropped: string[] = []) {
  const events = db.getTraceEvents(sr.id);
  const system = events.find((e) => e.kind === "system")?.content as { system_prompt?: string } | undefined;
  const input = events.find((e) => e.kind === "input")?.content ?? {};
  const output = events.filter((e) => e.kind === "output").pop()?.content ?? JSON.parse(sr.payload_json);
  return scrub(
    {
      trace_id: sr.id,
      run_id: sr.run_id,
      idea_id: sr.idea_id,
      stage: sr.stage,
      model: sr.model,
      agent: sr.agent,
      prompt_hash: sr.prompt_hash,
      system_prompt: system?.system_prompt ?? null,
      input,
      events: events.map((e) => ({ seq: e.seq, kind: e.kind, content: e.content })),
      output,
      verdict: sr.verdict,
      rules_fired: JSON.parse(sr.rules_fired ?? "[]"),
      self_found: sr.self_found === 1,
      cost_usd: sr.cost_usd,
      created_at: sr.created_at,
    },
    dropped,
  );
}

export function exportTraces(db: Db, outFile: string, runId?: string): { count: number; dropped: string[] } {
  const rows = db.listStageResults(runId ? { runId } : {});
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const dropped: string[] = [];
  const lines = rows.map((sr) => JSON.stringify(traceObject(db, sr, dropped)));
  fs.writeFileSync(outFile, lines.length ? lines.join("\n") + "\n" : "");
  return { count: lines.length, dropped };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const db = openDb(PATHS.db);
  const out = path.resolve(arg("out") ?? path.join(PATHS.traces, "traces.jsonl"));
  const r = exportTraces(db, out, arg("run"));
  console.log(`wrote ${r.count} traces to ${path.relative(process.cwd(), out)}${r.dropped.length ? ` (scrubbed ${r.dropped.length} forbidden keys: ${[...new Set(r.dropped)].join(",")})` : ""}`);
  db.close();
}
