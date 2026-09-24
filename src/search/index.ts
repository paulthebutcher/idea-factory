// Search clients with live, record and replay modes. Every call writes a tool_call and a
// tool_result trace event. Results are data: nothing in them is ever executed or followed.
import { exaSearchLive, exaFetchPageLive } from "./exa.js";
import { braveSearchLive } from "./brave.js";
import { readFixture, writeFixture, type Engine } from "./fixtures.js";
import type { PageResponse, SearchClientOptions, SearchResponse, SearchResult } from "./types.js";

export { SearchError, type SearchResult, type SearchResponse, type PageResponse, type InjectionSpec } from "./types.js";
export { FixtureMissingError, fixtureKey, fixturePath, normalizeQuery } from "./fixtures.js";

export interface SearchClients {
  exa_search(query: string, num_results?: number): Promise<SearchResponse>;
  brave_search(query: string, count?: number): Promise<SearchResponse>;
  fetch_page(url: string): Promise<PageResponse>;
  /** Estimated USD spent on live calls by this client. */
  liveSpendUsd(): number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createSearchClients(opts: SearchClientOptions): SearchClients {
  const { mode, fixtureDir, trace } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let liveSpend = 0;
  let injected = false;

  function spend(usd: number, what: string) {
    liveSpend += usd;
    opts.onSpend?.(usd, what);
  }

  function maybeInject(engine: "exa" | "brave", results: SearchResult[]): { results: SearchResult[]; injected: boolean } {
    if (!opts.inject || injected || opts.inject.engine !== engine || results.length === 0) return { results, injected: false };
    injected = true;
    const [first, ...rest] = results;
    return { results: [{ ...first, snippet: `${first.snippet} ${opts.inject.text}`.trim() }, ...rest], injected: true };
  }

  async function run<T>(engine: Engine, tool: string, query: string, params: Record<string, unknown>, live: () => Promise<{ value: T; costUsd: number }>): Promise<T> {
    trace.add("tool_call", { tool, engine, query, params, mode });
    try {
      let value: T;
      let source: "live" | "fixture";
      if (mode === "replay") {
        const fx = readFixture<T>(fixtureDir, engine, query);
        value = fx.response;
        source = "fixture";
      } else {
        const r = await live();
        value = r.value;
        source = "live";
        spend(r.costUsd, `${engine}:${query}`);
        if (mode === "record") {
          writeFixture(fixtureDir, { engine, query, params, recorded_at: new Date().toISOString(), cost_usd: r.costUsd, response: value });
        }
      }
      trace.add("tool_result", { tool, engine, query, ok: true, source, result: value });
      return value;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      trace.add("tool_result", { tool, engine, query, ok: false, error: message });
      throw e;
    }
  }

  return {
    async exa_search(query, num_results = 5) {
      return run<SearchResponse>("exa", "exa_search", query, { num_results }, async () => {
        const r = await exaSearchLive(query, num_results, timeoutMs);
        const inj = maybeInject("exa", r.results);
        return { value: { engine: "exa", query, results: inj.results }, costUsd: r.costUsd };
      });
    },
    async brave_search(query, count = 5) {
      return run<SearchResponse>("brave", "brave_search", query, { count }, async () => {
        const r = await braveSearchLive(query, count, timeoutMs);
        const inj = maybeInject("brave", r.results);
        return { value: { engine: "brave", query, results: inj.results }, costUsd: r.costUsd };
      });
    },
    async fetch_page(url) {
      return run<PageResponse>("exa_contents", "fetch_page", url, {}, async () => {
        const r = await exaFetchPageLive(url, timeoutMs);
        return { value: r.page, costUsd: r.costUsd };
      });
    },
    liveSpendUsd: () => liveSpend,
  };
}
