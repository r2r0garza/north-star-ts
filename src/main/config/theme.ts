// The main-process entry to the app's customizable brand theme. The pure color
// math lives in src/shared/theme.ts (shared with the renderer for live preview);
// this module layers on the two input sources and their precedence:
//
//   1. persisted in-app override  (Settings → Appearance, a ThemeSettings row)
//   2. env presets                (NEXT_accent_color / NEXT_neutral_color)
//   3. built-in defaults          (the exact colors shipped in globals.css)
//
// A saved in-app color wins over the env preset (see resolveBrandTheme); the env
// preset wins over the default (see brandThemeCss). When nothing overrides the
// defaults we return null so the renderer leaves globals.css untouched.
//
// IMPORTANT: read the env vars lazily (inside these functions), never at module
// top-level — ES imports are hoisted above index.ts's loadEnv(), so a top-level
// read would run before .env.local is loaded. This mirrors system-name.ts.

import {
  themeCssFromHexes,
  hexToOklch,
  DEFAULT_ACCENT_HEX,
  DEFAULT_NEUTRAL_HEX,
} from "../../shared/theme"
import * as settingsService from "../settings/service"

// Re-exported so existing importers (theme.test.ts) keep resolving from ./theme.
export { hexToOklch }

// The env-only brand theme (presets over defaults). Returns the recolored
// declarations for `:root` (light) + `.dark`, or null when neither env var is
// set (globals.css then stands verbatim). Invalid hex falls back to the default.
// Kept as the env-only path (used by tests); resolveBrandTheme layers the
// persisted override on top for the live app.
export function brandThemeCss(): { light: string; dark: string } | null {
  const accentRaw = process.env.NEXT_accent_color?.trim()
  const neutralRaw = process.env.NEXT_neutral_color?.trim()
  // Nothing configured → no override (globals.css stands verbatim).
  if (!accentRaw && !neutralRaw) return null
  return themeCssFromHexes(
    accentRaw || DEFAULT_ACCENT_HEX,
    neutralRaw || DEFAULT_NEUTRAL_HEX
  )
}

// The effective brand theme for the running app, resolving all three sources
// with precedence DB > env > default, per channel (accent and neutral resolve
// independently). Returns null only when NOTHING overrides the defaults, so the
// renderer can skip injecting a <style> and leave globals.css as-is.
export function resolveBrandTheme(): { light: string; dark: string } | null {
  const stored = settingsService.getTheme()
  const envAccent = process.env.NEXT_accent_color?.trim() || null
  const envNeutral = process.env.NEXT_neutral_color?.trim() || null

  const accent = stored.accent || envAccent
  const neutral = stored.neutral || envNeutral

  // No override from any source on either channel → leave globals.css untouched.
  if (!accent && !neutral) return null

  return themeCssFromHexes(
    accent || DEFAULT_ACCENT_HEX,
    neutral || DEFAULT_NEUTRAL_HEX
  )
}
