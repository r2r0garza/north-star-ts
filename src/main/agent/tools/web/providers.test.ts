import { describe, it, expect } from "vitest"
import { parseDuckDuckGoHtml } from "./providers"

// A trimmed but structurally-faithful capture of DuckDuckGo's html endpoint
// markup: results wrapped in `.result` with a `.result__a` anchor whose href is
// the `/l/?uddg=` redirect, plus a `.result__snippet`.
const SAMPLE = `
<html><body>
  <div class="result results_links results_links_deep web-result">
    <div class="result__body">
      <h2 class="result__title">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example Docs</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">The official docs for Example.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="result__body">
      <h2 class="result__title">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fblog.example.org%2Fpost">Blog Post</a>
      </h2>
      <a class="result__snippet">A relevant blog post about the topic.</a>
    </div>
  </div>
</body></html>
`

describe("parseDuckDuckGoHtml", () => {
  it("extracts title, decoded URL, and snippet per result", () => {
    const results = parseDuckDuckGoHtml(SAMPLE, 10)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: "Example Docs",
      url: "https://example.com/docs",
      snippet: "The official docs for Example.",
    })
    expect(results[1].title).toBe("Blog Post")
    expect(results[1].url).toBe("https://blog.example.org/post")
    expect(results[1].snippet).toBe("A relevant blog post about the topic.")
  })

  it("respects the limit", () => {
    const results = parseDuckDuckGoHtml(SAMPLE, 1)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe("Example Docs")
  })

  it("returns an empty array for markup with no results", () => {
    expect(parseDuckDuckGoHtml("<html><body>no results</body></html>", 10)).toEqual(
      []
    )
  })

  it("skips results missing a title or URL", () => {
    const html = `
      <div class="result web-result">
        <a class="result__a" href="">   </a>
        <a class="result__snippet">orphan snippet</a>
      </div>`
    expect(parseDuckDuckGoHtml(html, 10)).toEqual([])
  })
})
