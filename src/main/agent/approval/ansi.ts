// Strip ANSI escape sequences from text. Ported from hermes-tools/ansi_strip.py.
//
// Used to clean subprocess output before it enters the model's context (ANSI
// codes otherwise get copied verbatim into file writes), and to normalize a
// command string before danger-pattern matching so escape-byte obfuscation
// can't slip a dangerous command past the classifier.
//
// Covers the full ECMA-48 spec: CSI (including private-mode `?` prefix,
// colon-separated params, intermediate bytes), OSC (BEL and ST terminators),
// DCS/SOS/PM/APC string sequences, nF multi-byte escapes, Fp/Fe/Fs single-byte
// escapes, and 8-bit C1 control characters.

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[\x20-\x2f]+[\x30-\x7e]|[\x30-\x7e])|\x9b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x9d[\s\S]*?(?:\x07|\x9c)|[\x80-\x9f]/g

// Fast-path check — skip the full regex when no escape-like bytes are present.
// eslint-disable-next-line no-control-regex
const HAS_ESCAPE = /[\x1b\x80-\x9f]/

// Remove ANSI escape sequences from text. Returns the input unchanged (fast
// path) when no ESC or C1 bytes are present, so it's safe to call on any
// string with negligible overhead.
export function stripAnsi(text: string): string {
  if (!text || !HAS_ESCAPE.test(text)) return text
  return text.replace(ANSI_ESCAPE_RE, "")
}
