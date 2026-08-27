// Web-search provider abstraction. `web_search` is written against this small
// interface, with DuckDuckGo's HTML endpoint as the default implementation, so a
// real API provider (Tavily, Brave, …) can drop in later without touching the
// tool. Provider impls do the network call + parse; the tool formats the result.

import * as cheerio from "cheerio"
import { safeFetchText } from "./safe-fetch"

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchProvider {
  // A short id for logs/errors, e.g. "duckduckgo".
  readonly name: string
  // Run a query. `signal` cancels the in-flight request (turn Stop/timeout).
  // Throws on network/parse failure — the tool converts that to a toolError.
  search(
    query: string,
    opts: { limit: number; signal?: AbortSignal }
  ): Promise<WebSearchResult[]>
}

// A realistic, browser-like UA — DDG's HTML endpoint returns an empty/blocked
// page to obviously-bot clients.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
const SEARCH_TIMEOUT_MS = 15_000
const MAX_SEARCH_BODY_BYTES = 1024 * 1024

// DuckDuckGo has no official search API. This scrapes the "html" (no-JS)
// endpoint, which returns real result listings as static markup. Unofficial and
// inherently fragile: DDG can rate-limit or change the markup, in which case
// search() throws and the tool surfaces a clear error. Swap this provider for a
// keyed API when one is configured.
export class DuckDuckGoProvider implements WebSearchProvider {
  readonly name = "duckduckgo"

  async search(
    query: string,
    opts: { limit: number; signal?: AbortSignal }
  ): Promise<WebSearchResult[]> {
    const endpoint = "https://html.duckduckgo.com/html/"
    const body = new URLSearchParams({ q: query }).toString()
    const { response: res, text: html } = await safeFetchText(endpoint, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
      },
      body,
      signal: opts.signal,
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxBodyBytes: MAX_SEARCH_BODY_BYTES,
    })
    if (!res.ok) {
      throw new Error(`DuckDuckGo returned HTTP ${res.status}`)
    }
    return parseDuckDuckGoHtml(html, opts.limit)
  }
}

// Parse DDG's HTML result page into structured results. Exported for unit tests
// (parsing is the fragile part, so it's tested against a captured fixture).
// DDG wraps each result in `.result` with a `.result__a` anchor (title + href)
// and a `.result__snippet`. The href is often a `/l/?uddg=<encoded>` redirect —
// we decode it back to the real destination URL.
export function parseDuckDuckGoHtml(
  html: string,
  limit: number
): WebSearchResult[] {
  const $ = cheerio.load(html)
  const results: WebSearchResult[] = []
  $("div.result, div.web-result").each((_i, el) => {
    if (results.length >= limit) return false
    const anchor = $(el).find("a.result__a").first()
    const title = anchor.text().trim()
    const href = anchor.attr("href") ?? ""
    const url = decodeDuckDuckGoHref(href)
    const snippet = $(el).find(".result__snippet").first().text().trim()
    if (title && url) results.push({ title, url, snippet })
    return undefined
  })
  return results
}

// DDG result links are redirect URLs like
// "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...". Pull the real
// destination out of the `uddg` param; fall back to the href (normalizing a
// protocol-relative "//host" to https) when it isn't a redirect.
function decodeDuckDuckGoHref(href: string): string {
  if (!href) return ""
  try {
    const u = new URL(href, "https://duckduckgo.com")
    const uddg = u.searchParams.get("uddg")
    if (uddg) return uddg
    // A direct (non-redirect) link: return it absolute.
    return u.toString()
  } catch {
    return href
  }
}
