import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb, type Db } from "../../src/store/db.js";
import { seedIdeas } from "../../scripts/seed.js";
import { createRun } from "../../src/runner/run.js";
import { runKillGate, type KillGateRunResult } from "../../src/stages/kill_gate.js";
import { createSearchClients } from "../../src/search/index.js";
import { createModelClient } from "../../src/model/client.js";
import { TraceCollector } from "../../src/trace.js";
import { loadPrompts } from "../../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../..");
export const SEED_PATH = path.join(REPO_ROOT, "data/seed/seed_ideas.jsonl");
export const DEFAULT_FIXTURES = path.join(REPO_ROOT, "src/search/fixtures");
export const TEST_FIXTURES = path.join(here, "fixtures");

export const HIDDEN_FIELDS = ["seed_source", "set_name", "test_role", "notes", "labels", "outcomes", "label", "outcome", "bucket"];

/** Fresh, seeded SQLite store in a temp dir. Returns the db and its path. */
export function freshSeededDb(): { db: Db; dbPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-factory-test-"));
  const dbPath = path.join(dir, "factory.db");
  const db = openDb(dbPath);
  seedIdeas(db, SEED_PATH);
  return { db, dbPath, dir };
}

/** Spawn the MCP server as a separate process against dbPath and return a connected client. */
export async function spawnMcpClient(dbPath: string, name = "test-client"): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(REPO_ROOT, "src/mcp/server.ts")],
    cwd: REPO_ROOT,
    env: { ...(process.env as Record<string, string>), FACTORY_DB: dbPath },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

export function toolJson<T = any>(result: any): T {
  if (result.structuredContent) return result.structuredContent as T;
  const text = result.content?.find((c: any) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as T;
}

/** Recursively collect every object key in a value. */
export function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

export interface KillGateTestOptions {
  fixtureDir?: string;
  agent?: string;
  budgetUsd?: number;
}

/**
 * Run the kill gate for one idea in replay mode using the given fixture set.
 * Creates a run and a task, claims the task, runs the stage, and returns the result.
 */
export async function runKillGateReplay(db: Db, ideaId: string, opts: KillGateTestOptions = {}): Promise<KillGateRunResult> {
  const fixtureDir = opts.fixtureDir ?? DEFAULT_FIXTURES;
  const prompts = loadPrompts();
  const run = createRun(db, { stages: ["kill_gate"], ideaIds: [ideaId], budgetUsd: opts.budgetUsd ?? 5, searchMode: "replay", prompts });
  const task = db.listTasks(run.id).find((t) => t.idea_id === ideaId && t.stage === "kill_gate")!;
  const agent = opts.agent ?? "test";
  const claim = db.claimTask(task.id, agent);
  if (claim !== "claimed") throw new Error(`could not claim task ${task.id}: ${claim}`);
  const trace = new TraceCollector();
  const search = createSearchClients({ mode: "replay", fixtureDir, trace });
  const model = createModelClient({ mode: "replay", fixtureDir });
  return runKillGate({ db, runId: run.id, taskId: task.id, ideaId, agent, search, model, trace, prompts });
}
