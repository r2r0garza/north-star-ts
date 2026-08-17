// Pure color math for the app's customizable brand theme — no env, no Electron,
// no DOM. Shared by the main process (startup, reading env / persisted settings)
// and the renderer (live preview in Settings), so a preview matches the startup
// render exactly.
//
// Approach: keep each design token's carefully tuned LIGHTNESS ladder from
// globals.css and only re-color it —
//   • brand tokens (primary / sidebar-primary + their foregrounds): keep L, scale
//     chroma by the accent's saturation, and rotate to the accent's hue;
//   • neutral tokens (background / card / muted / border / …): keep L, replace
//     chroma + hue with the neutral's.
// Because the current green parses back to ~its own oklch and the current neutral
// is ~pure gray, passing the default hexes reproduces today's UI. `destructive`
// and the chart colors are semantic/fixed and are intentionally NOT recolored.

// The reference chroma: the light-mode primary's chroma. An accent whose parsed
// chroma equals this scales the brand ladder by 1 (i.e. no change).
const REF_ACCENT_CHROMA = 0.154

// Defaults — the exact values shipped in globals.css, expressed as hex so the
// two knobs share one input format. #008236 ≈ oklch(0.527 0.154 150) (the green
// primary); #0a0a0a ≈ oklch(0.145 0 0) (the dark neutral / near-black).
export const DEFAULT_ACCENT_HEX = "#008236"
export const DEFAULT_NEUTRAL_HEX = "#0a0a0a"

export interface Oklch {
  l: number
  c: number
  h: number
}

// One design token's baseline (its value in globals.css) plus how to recolor it.
// `a` is an optional alpha (0–1) preserved on output (e.g. dark --border).
interface Token {
  l: number
  c: number
  h: number
  a?: number
  kind: "brand" | "neutral"
}

// The tokens we recolor, per mode, taken verbatim from globals.css. Order is the
// emit order. Tokens absent here (destructive, chart-*, fonts, radius) are left
// to globals.css untouched.
const LIGHT_TOKENS: Record<string, Token> = {
  background: { l: 1, c: 0, h: 0, kind: "neutral" },
  foreground: { l: 0.145, c: 0, h: 0, kind: "neutral" },
  card: { l: 1, c: 0, h: 0, kind: "neutral" },
  "card-foreground": { l: 0.145, c: 0, h: 0, kind: "neutral" },
  popover: { l: 1, c: 0, h: 0, kind: "neutral" },
  "popover-foreground": { l: 0.145, c: 0, h: 0, kind: "neutral" },
  primary: { l: 0.527, c: 0.154, h: 150.069, kind: "brand" },
  "primary-foreground": { l: 0.982, c: 0.018, h: 155.826, kind: "brand" },
  secondary: { l: 0.967, c: 0.001, h: 286.375, kind: "neutral" },
  "secondary-foreground": { l: 0.21, c: 0.006, h: 285.885, kind: "neutral" },
  muted: { l: 0.97, c: 0, h: 0, kind: "neutral" },
  "muted-foreground": { l: 0.556, c: 0, h: 0, kind: "neutral" },
  accent: { l: 0.97, c: 0, h: 0, kind: "neutral" },
  "accent-foreground": { l: 0.205, c: 0, h: 0, kind: "neutral" },
  border: { l: 0.922, c: 0, h: 0, kind: "neutral" },
  input: { l: 0.922, c: 0, h: 0, kind: "neutral" },
  ring: { l: 0.708, c: 0, h: 0, kind: "neutral" },
  sidebar: { l: 0.985, c: 0, h: 0, kind: "neutral" },
  "sidebar-foreground": { l: 0.145, c: 0, h: 0, kind: "neutral" },
  "sidebar-primary": { l: 0.627, c: 0.194, h: 149.214, kind: "brand" },
  "sidebar-primary-foreground": {
    l: 0.982,
    c: 0.018,
    h: 155.826,
    kind: "brand",
  },
  "sidebar-accent": { l: 0.97, c: 0, h: 0, kind: "neutral" },
  "sidebar-accent-foreground": { l: 0.205, c: 0, h: 0, kind: "neutral" },
  "sidebar-border": { l: 0.922, c: 0, h: 0, kind: "neutral" },
  "sidebar-ring": { l: 0.708, c: 0, h: 0, kind: "neutral" },
}

const DARK_TOKENS: Record<string, Token> = {
  background: { l: 0.145, c: 0, h: 0, kind: "neutral" },
  foreground: { l: 0.985, c: 0, h: 0, kind: "neutral" },
  card: { l: 0.205, c: 0, h: 0, kind: "neutral" },
  "card-foreground": { l: 0.985, c: 0, h: 0, kind: "neutral" },
  popover: { l: 0.205, c: 0, h: 0, kind: "neutral" },
  "popover-foreground": { l: 0.985, c: 0, h: 0, kind: "neutral" },
  primary: { l: 0.448, c: 0.119, h: 151.328, kind: "brand" },
  "primary-foreground": { l: 0.982, c: 0.018, h: 155.826, kind: "brand" },
  secondary: { l: 0.274, c: 0.006, h: 286.033, kind: "neutral" },
  "secondary-foreground": { l: 0.985, c: 0, h: 0, kind: "neutral" },
  muted: { l: 0.269, c: 0, h: 0, kind: "neutral" },
  "muted-foreground": { l: 0.708, c: 0, h: 0, kind: "neutral" },
  accent: { l: 0.269, c: 0, h: 0, kind: "neutral" },
  "accent-foreground": { l: 0.985, c: 0, h: 0, kind: "neutral" },
  border: { l: 1, c: 0, h: 0, a: 0.1, kind: "neutral" },
  input: { l: 1, c: 0, h: 0, a: 0.15, kind: "neutral" },
  ring: { l: 0.556, c: 0, h: 0, kind: "neutral" },
  sidebar: { l: 0.205, c: 0, h: 0, kind: "neutral" },
  "sidebar-foreground": { l: 0.985, c: 0, h: 0, kind: "neutral" },
  "sidebar-primary": { l: 0.723, c: 0.219, h: 149.579, kind: "brand" },
  "sidebar-primary-foreground": {
    l: 0.982,
    c: 0.018,
    h: 155.826,
    kind: "brand",
  },
  "sidebar-accent": { l: 0.269, c: 0, h: 0, kind: "neutral" },
  "sidebar-accent-foreground": { l: 0.985, c: 0, h: 0, kind: "neutral" },
  "sidebar-border": { l: 1, c: 0, h: 0, a: 0.1, kind: "neutral" },
  "sidebar-ring": { l: 0.556, c: 0, h: 0, kind: "neutral" },
}

// ── Color math (sRGB hex → OKLCh), no dependency ────────────────────────────

function srgbToLinear(v: number): number {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

// Parse "#rgb" / "#rrggbb" (with or without the hash) to OKLCh, or null if the
// string isn't a valid hex color.
export function hexToOklch(hex: string): Oklch | null {
  let h = hex.trim().replace(/^#/, "")
  if (h.length === 3) {
    h = h
      .split("")
      .map((ch) => ch + ch)
      .join("")
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  const r = srgbToLinear(parseInt(h.slice(0, 2), 16))
  const g = srgbToLinear(parseInt(h.slice(2, 4), 16))
  const b = srgbToLinear(parseInt(h.slice(4, 6), 16))
  // linear sRGB → OKLab (Björn Ottosson's matrices).
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const aa = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  const c = Math.sqrt(aa * aa + bb * bb)
  let hue = (Math.atan2(bb, aa) * 180) / Math.PI
  if (hue < 0) hue += 360
  return { l: L, c, h: hue }
}

function round(n: number, places: number): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}

// Format an OKLCh triple (+ optional alpha) as a CSS oklch() string, matching
// globals.css's style: `oklch(0.145 0 0)` / `oklch(1 0 0 / 10%)`.
function oklchString(l: number, c: number, h: number, a?: number): string {
  const base = `${round(l, 3)} ${round(c, 3)} ${round(h, 3)}`
  return a === undefined
    ? `oklch(${base})`
    : `oklch(${base} / ${round(a * 100, 1)}%)`
}

// ── Token generation ─────────────────────────────────────────────────────────

function recolor(token: Token, accent: Oklch, neutral: Oklch): string {
  if (token.kind === "brand") {
    // Keep L, scale chroma to the accent's saturation, rotate to its hue.
    const factor = accent.c / REF_ACCENT_CHROMA
    return oklchString(token.l, token.c * factor, accent.h, token.a)
  }
  // Neutral: keep L, replace chroma + hue with the neutral's. A (near-)pure gray
  // has an arbitrary hue at zero chroma, so pin hue to 0 — this makes a gray
  // neutral emit exactly `oklch(L 0 0)`, matching globals.css verbatim.
  const isGray = neutral.c < 0.002
  return oklchString(
    token.l,
    isGray ? 0 : neutral.c,
    isGray ? 0 : neutral.h,
    token.a
  )
}

function emit(
  tokens: Record<string, Token>,
  accent: Oklch,
  neutral: Oklch
): string {
  return Object.entries(tokens)
    .map(([name, tok]) => `--${name}: ${recolor(tok, accent, neutral)};`)
    .join(" ")
}

// Build the recolored CSS custom-property declarations for `:root` (light) and
// `.dark` from an accent + neutral hex. Invalid hex falls back to that channel's
// default, so a bad input never throws (matching the env path's tolerance).
// Passing the default hexes reproduces globals.css verbatim.
export function themeCssFromHexes(
  accentHex: string,
  neutralHex: string
): { light: string; dark: string } {
  const accent = hexToOklch(accentHex) || hexToOklch(DEFAULT_ACCENT_HEX)!
  const neutral = hexToOklch(neutralHex) || hexToOklch(DEFAULT_NEUTRAL_HEX)!
  return {
    light: emit(LIGHT_TOKENS, accent, neutral),
    dark: emit(DARK_TOKENS, accent, neutral),
  }
}
