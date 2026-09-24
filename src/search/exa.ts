import { SEARCH_COST_USD } from "../config.js";
import { SearchError, withRetry, type PageResponse, type SearchResult } from "./types.js";

const EXA_BASE = "https://api.exa.ai";

function key(): string {
  const k = process.env.EXA_API_KEY;
  if (!k) throw new SearchError("exa", "EXA_API_KEY is not set");
  return k;
}

async function post(pathname: string, body: unknown, timeoutMs: number): Promise<any> {
  return withRetry(async () => {
    const res = await fetch(`${EXA_BASE}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new SearchError("exa", `HTTP ${res.status} ${text}`, res.status);
    }
    return res.json();
  });
}

/** Exa search with contents. Returns normalized results and the provider-reported cost when present. */
export async function exaSearchLive(query: string, numResults: number, timeoutMs: number): Promise<{ results: SearchResult[]; costUsd: number }> {
  const data = await post("/search", { query, numResults, type: "auto", contents: { text: { maxCharacters: 1500 } } }, timeoutMs);
  const results: SearchResult[] = (data.results ?? []).map((r: any) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: String(r.text ?? r.highlights?.join(" ") ?? "").slice(0, 1500),
    published: r.publishedDate ?? null,
  }));
  const costUsd = typeof data?.costDollars?.total === "number" ? data.costDollars.total : SEARCH_COST_USD.exa_search;
  return { results, costUsd };
}

/** Exa contents endpoint for one URL. */
export async function exaFetchPageLive(url: string, timeoutMs: number): Promise<{ page: PageResponse; costUsd: number }> {
  const data = await post("/contents", { urls: [url], text: { maxCharacters: 8000 } }, timeoutMs);
  const r = (data.results ?? [])[0];
  if (!r) throw new SearchError("exa", `no content returned for ${url}`);
  const page: PageResponse = { url: String(r.url ?? url), title: String(r.title ?? ""), text: String(r.text ?? "").slice(0, 8000) };
  const costUsd = typeof data?.costDollars?.total === "number" ? data.costDollars.total : SEARCH_COST_USD.exa_contents;
  return { page, costUsd };
}
