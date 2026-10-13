export function isBrowserAddressShortcut(
  input: {
    key: string
    meta?: boolean
    control?: boolean
    alt?: boolean
    shift?: boolean
  },
  platform: string
): boolean {
  return (
    input.key.toLowerCase() === "l" &&
    !input.alt &&
    !input.shift &&
    (platform === "darwin"
      ? !!input.meta && !input.control
      : !!input.control && !input.meta)
  )
}
