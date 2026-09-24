import type { Mode } from "../config.js";
import type { TraceCollector } from "../trace.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published: string | null;
}

export interface SearchResponse {
  engine: "exa" | "brave";
  query: string;
  results: SearchResult[];
}

export interface PageResponse {
  url: string;
  title: string;
  text: string;
}

/** Deterministic injection used only when recording the AC11 fixture set. */
export interface InjectionSpec {
  engine: "exa" | "brave";
  text: string;
}

export interface SearchClientOptions {
  mode: Mode;
  fixtureDir: string;
  trace: TraceCollector;
  inject?: InjectionSpec;
  /** Called with the estimated USD cost of every live call. */
  onSpend?: (usd: number, what: string) => void;
  timeoutMs?: number;
}

export class SearchError extends Error {
  constructor(public readonly engine: string, message: string, public readonly status?: number) {
    super(`${engine}: ${message}`);
  }
}
