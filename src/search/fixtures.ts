import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../config.js";

export type Engine = "exa" | "brave" | "exa_contents";

export class FixtureMissingError extends Error {
  constructor(engine: string, query: string, file: string) {
    super(`no recorded fixture for ${engine} query "${query}" (${path.basename(file)})`);
  }
}

export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

/** Fixtures are keyed by a hash of engine plus query. */
export function fixtureKey(engine: Engine, query: string): string {
  return sha256(`${engine}\n${normalizeQuery(query)}`);
}

export function fixturePath(dir: string, engine: Engine, query: string): string {
  return path.join(dir, engine, `${fixtureKey(engine, query)}.json`);
}

export interface SearchFixture<T = unknown> {
  engine: Engine;
  query: string;
  params: Record<string, unknown>;
  recorded_at: string;
  cost_usd: number;
  response: T;
}

export function readFixture<T>(dir: string, engine: Engine, query: string): SearchFixture<T> {
  const file = fixturePath(dir, engine, query);
  if (!fs.existsSync(file)) throw new FixtureMissingError(engine, query, file);
  return JSON.parse(fs.readFileSync(file, "utf8")) as SearchFixture<T>;
}

export function writeFixture<T>(dir: string, fixture: SearchFixture<T>): string {
  const file = fixturePath(dir, fixture.engine, fixture.query);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
  return file;
}
