export function localFileLink(href: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null
  if (/^file:/i.test(href)) return href
  if (/^[a-z]:[\\/]/i.test(href)) return href
  if (/^sandbox:\//i.test(href)) return href.slice("sandbox:".length)
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return null
  return href.split(/[?#]/, 1)[0] || null
}

export function markdownLinkUrl(url: string): string {
  if (localFileLink(url) !== null || /^(https?:|mailto:)/i.test(url)) return url
  return ""
}
