import { describe, it, expect } from "vitest"
import { extractReadable } from "./extract"

describe("extractReadable", () => {
  it("pulls the title and converts the main content to markdown", () => {
    const html = `
      <html>
        <head><title>My Article</title></head>
        <body>
          <nav>Home | About</nav>
          <main>
            <h1>Heading</h1>
            <p>First paragraph with <a href="https://x.com">a link</a>.</p>
            <ul><li>one</li><li>two</li></ul>
          </main>
          <footer>© 2026</footer>
        </body>
      </html>`
    const { title, markdown } = extractReadable(html)
    expect(title).toBe("My Article")
    expect(markdown).toContain("# Heading")
    expect(markdown).toContain("First paragraph with [a link](https://x.com).")
    // turndown pads list markers with alignment spaces ("-   one").
    expect(markdown).toMatch(/-\s+one/)
    expect(markdown).toMatch(/-\s+two/)
  })

  it("drops chrome (nav/header/footer/script/style)", () => {
    const html = `
      <html><head><title>T</title>
        <style>.a{color:red}</style>
      </head><body>
        <header>SITE HEADER</header>
        <nav>NAVIGATION</nav>
        <main><p>Real content.</p></main>
        <footer>FOOTER TEXT</footer>
        <script>console.log("tracking")</script>
      </body></html>`
    const { markdown } = extractReadable(html)
    expect(markdown).toContain("Real content.")
    expect(markdown).not.toContain("SITE HEADER")
    expect(markdown).not.toContain("NAVIGATION")
    expect(markdown).not.toContain("FOOTER TEXT")
    expect(markdown).not.toContain("tracking")
  })

  it("falls back to body when there is no main/article", () => {
    const html = `<html><head><title>T</title></head><body><p>Just a body.</p></body></html>`
    const { markdown } = extractReadable(html)
    expect(markdown).toContain("Just a body.")
  })

  it("returns empty markdown (not a throw) for empty input", () => {
    const { title, markdown } = extractReadable("")
    expect(title).toBe("")
    expect(markdown).toBe("")
  })
})
