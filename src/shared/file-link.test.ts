import { expect, it } from "vitest"
import { localFileLink, markdownLinkUrl } from "./file-link"

it.each([
  "C:\\Users\\Test\\report.md",
  "D:/work/report.md",
  "file:///C:/work/report.md",
  "/home/test/report.md",
  "report.md",
])("recognizes local download path %s", (path) => {
  expect(localFileLink(path)).toBe(path)
  expect(markdownLinkUrl(path)).toBe(path)
})
it.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "https://example.com/report",
  "//example.com/report",
])("does not treat %s as a local file", (url) => {
  expect(localFileLink(url)).toBeNull()
})
