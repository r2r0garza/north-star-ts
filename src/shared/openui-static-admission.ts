export const OPENUI_STATIC_LIMITS = {
  bytes: 64 * 1024,
  depth: 24,
  components: 200,
  values: 4000,
  text: 2000,
} as const

export const OPENUI_STATIC_COMPONENTS = [
  "Stack",
  "Row",
  "Text",
  "Card",
  "Metric",
  "Chart",
  "DataTable",
  "Tabs",
  "Tab",
  "Concept",
] as const

// shortcut: static inline syntax only; revisit with a bounded upstream parser before allowing references or expressions.
export function admitStaticOpenui(source: string): string {
  if (
    typeof source !== "string" ||
    new TextEncoder().encode(source).length > OPENUI_STATIC_LIMITS.bytes
  )
    throw new Error("OpenUI source exceeds the 64 KiB limit.")
  let offset = 0
  let values = 0
  let components = 0
  const skip = () => {
    while (/\s/.test(source[offset] ?? "") && offset < source.length) offset++
  }
  const take = (token: string) => {
    skip()
    if (!source.startsWith(token, offset))
      throw new Error(
        token === ";"
          ? `Expected final ; at ${offset}, found ${offset === source.length ? "end of document" : JSON.stringify(source[offset])}. End the single root assignment with ; and check that all Tab calls remain inside the same Tabs array.`
          : `Expected ${token} at ${offset}.`
      )
    offset += token.length
  }
  const value = (depth: number): string => {
    skip()
    if (
      depth > OPENUI_STATIC_LIMITS.depth ||
      ++values > OPENUI_STATIC_LIMITS.values
    )
      throw new Error("OpenUI nesting or value budget exceeded.")
    if (source[offset] === '"') {
      const match =
        /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/.exec(
          source.slice(offset)
        )
      if (!match) throw new Error("Expected a JSON string.")
      const text: string = JSON.parse(match[0])
      if (text.length > OPENUI_STATIC_LIMITS.text)
        throw new Error("OpenUI text limit exceeded.")
      offset += match[0].length
      // Prevent language delimiters inside text from acquiring syntax in downstream parsing.
      return JSON.stringify(text).replace(/;/g, "\\u003b").replace(/\n/g, "\\n")
    }
    if (source[offset] === "[") {
      take("[")
      const items: string[] = []
      skip()
      if (source[offset] !== "]") {
        items.push(value(depth + 1))
        skip()
        while (source[offset] === ",") {
          take(",")
          items.push(value(depth + 1))
          skip()
        }
      }
      take("]")
      return `[${items.join(",")}]`
    }
    const literal =
      /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w.])/.exec(
        source.slice(offset)
      )
    if (literal) {
      offset += literal[0].length
      if (
        !Number.isFinite(Number(literal[0])) &&
        !["null", "true", "false"].includes(literal[0])
      )
        throw new Error("Non-finite number.")
      return literal[0]
    }
    const name = /^[A-Za-z]+/.exec(source.slice(offset))?.[0]
    if (
      !name ||
      !(OPENUI_STATIC_COMPONENTS as readonly string[]).includes(name)
    )
      throw new Error(
        "Only registered inline presentation components and literals are allowed."
      )
    if (++components > OPENUI_STATIC_LIMITS.components)
      throw new Error("OpenUI component budget exceeded.")
    offset += name.length
    take("(")
    const args: string[] = []
    skip()
    if (source[offset] !== ")") {
      args.push(value(depth + 1))
      skip()
      while (source[offset] === ",") {
        take(",")
        args.push(value(depth + 1))
        skip()
      }
    }
    take(")")
    return `${name}(${args.join(",")})`
  }
  take("root")
  take("=")
  const body = value(0)
  if (!/^[A-Z]/.test(body))
    throw new Error("Root must be a presentation component.")
  take(";")
  skip()
  if (offset !== source.length)
    throw new Error("Only one root statement is allowed.")
  return `root = ${body};`
}
