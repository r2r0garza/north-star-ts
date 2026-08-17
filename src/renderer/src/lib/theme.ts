import {
  themeCssFromHexes,
  DEFAULT_ACCENT_HEX,
  DEFAULT_NEUTRAL_HEX,
} from "../../../shared/theme"

// Renderer-side brand-theme application. The recolor math lives in the shared
// module; this owns the single <style id="brand-theme"> the app injects after
// globals.css to override the default design tokens (light + dark), while
// next-themes keeps toggling the `.dark` class. Used by both startup
// (main.tsx applyBrandTheme) and the Settings → Appearance live preview, so the
// preview matches the startup render exactly.

const STYLE_ID = "brand-theme"

// Write the recolored declarations into the <style id="brand-theme"> (creating it
// on first use). Passing null removes the override, reverting to globals.css.
export function applyThemeCss(theme: { light: string; dark: string } | null) {
  const existing = document.getElementById(STYLE_ID)
  if (!theme) {
    existing?.remove()
    return
  }
  const style = existing ?? document.createElement("style")
  style.id = STYLE_ID
  style.textContent = `:root { ${theme.light} }\n.dark { ${theme.dark} }`
  if (!existing) document.head.appendChild(style)
}

// Recolor + apply from an accent/neutral hex pair (nulls fall back to the
// built-in defaults). The live-preview entry point for Settings → Appearance.
export function applyThemeColors(accent: string | null, neutral: string | null) {
  applyThemeCss(
    themeCssFromHexes(accent || DEFAULT_ACCENT_HEX, neutral || DEFAULT_NEUTRAL_HEX)
  )
}
