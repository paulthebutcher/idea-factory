import { SEARCH_COST_USD } from "../config.js";
import { SearchError, type SearchResult } from "./types.js";

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

export async function braveSearchLive(query: string, count: number, timeoutMs: number): Promise<{ results: SearchResult[]; costUsd: number }> {
  const k = process.env.BRAVE_API_KEY;
  if (!k) throw new SearchError("brave", "BRAVE_API_KEY is not set");
  const url = new URL(BRAVE_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const res = await fetch(url, {
    headers: { accept: "application/json", "accept-encoding": "gzip", "x-subscription-token": k },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new SearchError("brave", `HTTP ${res.status} ${text}`, res.status);
  }
  const data: any = await res.json();
  const results: SearchResult[] = (data?.web?.results ?? []).map((r: any) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: String(r.description ?? "").slice(0, 1500),
    published: r.page_age ?? r.age ?? null,
  }));
  return { results, costUsd: SEARCH_COST_USD.brave_search };
}
