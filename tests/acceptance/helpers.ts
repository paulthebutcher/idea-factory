import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb, type Db } from "../../src/store/db.js";
import { seedIdeas } from "../../scripts/seed.js";

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
