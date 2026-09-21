import type { ToolAction } from "../../approval/types"

export function webFetchOrigin(url: URL): string {
  return url.origin
}

export function webFetchAction(url: URL): ToolAction {
  const origin = webFetchOrigin(url)
  return {
    tool: "web_fetch",
    kind: "web",
    summary: `Fetch ${url.href}`,
    identity: `web_fetch_origin:${origin}`,
    detail: { url: url.href, origin },
  }
}
