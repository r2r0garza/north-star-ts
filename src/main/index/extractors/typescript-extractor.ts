import ts from "typescript"
import type { Extractor, ExtractableFile, ExtractedDocument, ExtractedSymbol } from "./types"

const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])

// Extracts declarations + imports from TS/JS via the TypeScript compiler API
// (ts.createSourceFile → AST). No type-checking, no program/host — a single-file
// parse, which is cheap and dependency-free of the rest of the workspace. Never
// throws: a parse error yields whatever symbols were collected before it.
export const typeScriptExtractor: Extractor = {
  supports: (file) => TS_EXTS.has(file.ext),

  extract: (file: ExtractableFile): ExtractedDocument => {
    const symbols: ExtractedSymbol[] = []
    let source: ts.SourceFile
    try {
      source = ts.createSourceFile(
        file.relPath,
        file.content,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        scriptKindFor(file.ext)
      )
    } catch {
      return { symbols: [] }
    }

    const lineOf = (node: ts.Node): number =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

    const isExported = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)

    // Only walk top-level statements + one level into namespaces/exported blocks.
    // A full recursive walk would surface every local const; the index wants the
    // file's public/structural shape, not every binding.
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        symbols.push({
          name: node.name.text,
          kind: "function",
          line: lineOf(node),
          detail: { exported: isExported(node) },
        })
      } else if (ts.isClassDeclaration(node) && node.name) {
        symbols.push({
          name: node.name.text,
          kind: "class",
          line: lineOf(node),
          detail: { exported: isExported(node) },
        })
      } else if (ts.isInterfaceDeclaration(node)) {
        symbols.push({
          name: node.name.text,
          kind: "interface",
          line: lineOf(node),
          detail: { exported: isExported(node) },
        })
      } else if (ts.isTypeAliasDeclaration(node)) {
        symbols.push({
          name: node.name.text,
          kind: "type",
          line: lineOf(node),
          detail: { exported: isExported(node) },
        })
      } else if (ts.isEnumDeclaration(node)) {
        symbols.push({
          name: node.name.text,
          kind: "enum",
          line: lineOf(node),
          detail: { exported: isExported(node) },
        })
      } else if (ts.isVariableStatement(node)) {
        const exported = isExported(node)
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            symbols.push({
              name: decl.name.text,
              kind: "const",
              line: lineOf(decl),
              detail: { exported },
            })
          }
        }
      } else if (ts.isImportDeclaration(node)) {
        collectImport(node, symbols, lineOf(node))
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        // `export ... from "mod"` — record the re-export source module.
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          symbols.push({
            name: node.moduleSpecifier.text,
            kind: "export",
            line: lineOf(node),
            detail: { module: node.moduleSpecifier.text, reexport: true },
          })
        }
      }
    }

    source.forEachChild(visit)
    return { symbols }
  },
}

// An import declaration → one `import` symbol per bound name, all tagged with the
// source module so the query tool can answer "what imports X". Named after the
// module when there are no bindings (bare `import "x"`).
function collectImport(node: ts.ImportDeclaration, out: ExtractedSymbol[], line: number): void {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return
  const module = node.moduleSpecifier.text
  const clause = node.importClause
  const names: string[] = []
  if (clause) {
    if (clause.name) names.push(clause.name.text) // default import
    const bindings = clause.namedBindings
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        names.push(bindings.name.text) // * as ns
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) names.push(el.name.text)
      }
    }
  }
  if (names.length === 0) {
    out.push({ name: module, kind: "import", line, detail: { module } })
    return
  }
  for (const name of names) {
    out.push({ name, kind: "import", line, detail: { module } })
  }
}

function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX
    case ".jsx":
      return ts.ScriptKind.JSX
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TS
  }
}
