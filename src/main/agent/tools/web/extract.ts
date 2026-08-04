// Turn a fetched HTML page into clean, readable markdown for the model. We strip
// the obvious non-content chrome (scripts, styles, nav/header/footer/aside), then
// convert what's left to markdown with turndown. Exported separately so it can be
// unit-tested against HTML fixtures without a network call.

import * as cheerio from "cheerio"
import TurndownService from "turndown"

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
})
// Drop elements that carry no reading value even if they survive the cheerio
// pass (turndown would otherwise emit their text or empty artifacts).
turndown.remove(["script", "style", "noscript", "iframe", "form"])

// Tags that are almost always page chrome, not content. Removed before
// conversion so the markdown is the article/body, not the nav and footer.
const CHROME_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "[role=navigation]",
  "[role=banner]",
  "[role=contentinfo]",
].join(", ")

export interface ExtractedPage {
  title: string
  markdown: string
}

// Extract a title + markdown body from raw HTML. Prefers a semantic <main> or
// <article> as the content root when present (that's the page's real content);
// otherwise falls back to <body>. Never throws — worst case returns empty
// markdown, which the caller reports as an empty page.
export function extractReadable(html: string): ExtractedPage {
  const $ = cheerio.load(html)
  const title = ($("title").first().text() || "").trim()

  $(CHROME_SELECTORS).remove()

  // Pick the most content-ful semantic root if one exists.
  const root =
    $("main").first().html() ||
    $("article").first().html() ||
    $("body").html() ||
    html

  let markdown = ""
  try {
    markdown = turndown.turndown(root).trim()
  } catch {
    // turndown can throw on pathological markup — fall back to text content.
    markdown = $(root).text().trim()
  }
  // Collapse runs of blank lines turndown leaves behind around removed chrome.
  markdown = markdown.replace(/\n{3,}/g, "\n\n")
  return { title, markdown }
}
