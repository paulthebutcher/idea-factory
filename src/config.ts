import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..");

// Load .env once, if present. Values are never printed or logged anywhere in this codebase.
try {
  const envPath = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
} catch {
  /* ignore: environment variables may already be set */
}

export type Mode = "live" | "record" | "replay";
export type Stage = "kill_gate" | "viability" | "critic";

// Verified against https://platform.claude.com/docs/en/about-claude/models/overview on 2026-09-23.
export const MODELS = {
  kill_gate: "claude-sonnet-5",
  viability: "claude-sonnet-5",
  critic: "claude-opus-5-5",
} as const;

// USD per million tokens. Cache read is 10% of input on Sonnet 5 and 5% on Opus 5.5; cache write is 1.25x input.
export const PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
};

// Rough per-call search costs used for budget accounting. Conservative on purpose.
export const SEARCH_COST_USD = { exa_search: 0.01, exa_contents: 0.005, brave_search: 0.005 } as const;

export const PATHS = {
  db: process.env.FACTORY_DB ? path.resolve(process.env.FACTORY_DB) : path.join(REPO_ROOT, "data/factory.db"),
  schema: path.join(REPO_ROOT, "schema.sql"),
  seed: path.join(REPO_ROOT, "data/seed/seed_ideas.jsonl"),
  prompts: path.join(REPO_ROOT, "prompts"),
  fixtures: process.env.FIXTURE_DIR ? path.resolve(process.env.FIXTURE_DIR) : path.join(REPO_ROOT, "src/search/fixtures"),
  ledger: path.join(REPO_ROOT, "ledger"),
  traces: path.join(REPO_ROOT, "traces"),
};

function parseMode(v: string | undefined, fallback: Mode): Mode {
  if (v === "live" || v === "record" || v === "replay") return v;
  return fallback;
}

export const ENV = {
  runBudgetUsd: Number(process.env.RUN_BUDGET_USD ?? 20),
  searchMode: parseMode(process.env.SEARCH_MODE, "replay"),
  modelMode: parseMode(process.env.MODEL_MODE, parseMode(process.env.SEARCH_MODE, "replay")),
  hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
  hasExaKey: Boolean(process.env.EXA_API_KEY),
  hasBraveKey: Boolean(process.env.BRAVE_API_KEY),
};

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export interface PromptSet {
  kill_gate: { text: string; hash: string };
  viability: { text: string; hash: string };
  critic: { text: string; hash: string };
}

/** Prompt templates plus their hashes. The hash is of the raw template file, before substitution. */
export function loadPrompts(dir = PATHS.prompts): PromptSet {
  const load = (name: string) => {
    const text = fs.readFileSync(path.join(dir, `${name}.md`), "utf8");
    return { text, hash: sha256(text) };
  };
  return { kill_gate: load("kill_gate"), viability: load("viability"), critic: load("critic") };
}

export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v == null ? "(none)" : String(v);
  });
}

export function modelCostUsd(model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const p = PRICING[model];
  if (!p) throw new Error(`no pricing for model ${model}`);
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (usage.input_tokens * p.input + usage.output_tokens * p.output + cacheRead * p.cache_read + cacheWrite * p.cache_write) / 1_000_000;
}
