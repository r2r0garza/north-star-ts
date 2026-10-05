import path from "path"

// Stage 2 (plan 106.11): which projects the workspace holds and what builds
// them. Pure over a file list (workspace-relative, "/" separators) plus a
// reader for small manifests, so every layout is a unit test.

export type EcosystemId =
  // Python
  | "uv"
  | "poetry"
  | "pipenv"
  | "pip"
  | "conda"
  // JavaScript / TypeScript
  | "pnpm"
  | "npm"
  | "yarn"
  | "bun"
  | "deno"
  // Java / Kotlin
  | "maven"
  | "gradle"
  // C#
  | "dotnet"
  // C / C++
  | "cmake"
  | "meson"
  | "autotools"
  | "make"
  | "bazel"
  | "conan"
  | "vcpkg"
  // PHP
  | "composer"
  // Go
  | "go"
  // Rust
  | "cargo"
  // Swift
  | "swiftpm"
  | "cocoapods"
  | "carthage"
  | "xcode"
  | "tuist"
  | "xcodegen"
  // Ruby
  | "bundler"
  // Dart
  | "pub"
  | "melos"
  // SQL
  | "dbt"

export type Language =
  | "Python"
  | "JavaScript"
  | "TypeScript"
  | "Java"
  | "Kotlin"
  | "C#"
  | "C"
  | "C++"
  | "PHP"
  | "Go"
  | "Rust"
  | "Swift"
  | "Ruby"
  | "SQL"
  | "Dart"

export interface ProjectRoot {
  // Workspace-relative directory; "" is the workspace root.
  dir: string
  ecosystems: EcosystemId[]
  // Language facts that change recipes.
  flags: {
    typescript: boolean
    kotlin: boolean
    android: boolean
    flutter: boolean
    // Declared workspaces/monorepo members under this root.
    workspaces: boolean
    // C vs C++ sources, for labeling.
    cSources: boolean
    cppSources: boolean
    javaSources: boolean
    yarnBerry: boolean
    yarnPnp: boolean
  }
  // Member project dirs this root installs for (monorepo packages).
  members: string[]
  // Files in this root's directory (names only), for recipes.
  files: string[]
}

export interface ToolchainPin {
  tool:
    | "python"
    | "node"
    | "java"
    | "ruby"
    | "rust"
    | "go"
    | "dotnet"
    | "flutter"
    | "dart"
    | "php"
    | "xcode"
    | "swift"
    | "pnpm"
    | "yarn"
    | "bun"
    | "cmake"
  // The requirement as written: "3.12", ">=18", "1.79.0", "stable".
  required: string
  // Where it's declared (workspace-relative).
  file: string
  // "exact" pins a version (possibly a prefix); "range" is a constraint.
  kind: "exact" | "range"
}

export interface Inventory {
  roots: ProjectRoot[]
  pins: ToolchainPin[]
  // Roots dropped past the cap, so the checklist can say so.
  truncatedRoots: number
}

export type Reader = (file: string) => Promise<string | null>

const MAX_DEPTH = 4
const MAX_ROOTS = 16

// Directories whose manifests belong to someone else (vendored code, test
// fixtures), never a project to set up.
const SKIPPED_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "third-party",
  "Pods",
  "Carthage",
  ".git",
  "bower_components",
  "fixtures",
  "__fixtures__",
  "testdata",
  "test-fixtures",
  ".venv",
  "venv",
  ".tox",
  "site-packages",
  ".build",
  ".dart_tool",
  "target",
  "dist",
  "build",
  "out",
])

export const ECOSYSTEM_INFO: Record<
  EcosystemId,
  { language: Language; manager: string }
> = {
  uv: { language: "Python", manager: "uv" },
  poetry: { language: "Python", manager: "Poetry" },
  pipenv: { language: "Python", manager: "Pipenv" },
  pip: { language: "Python", manager: "pip + venv" },
  conda: { language: "Python", manager: "conda" },
  pnpm: { language: "JavaScript", manager: "pnpm" },
  npm: { language: "JavaScript", manager: "npm" },
  yarn: { language: "JavaScript", manager: "Yarn" },
  bun: { language: "JavaScript", manager: "Bun" },
  deno: { language: "JavaScript", manager: "Deno" },
  maven: { language: "Java", manager: "Maven" },
  gradle: { language: "Java", manager: "Gradle" },
  dotnet: { language: "C#", manager: ".NET SDK" },
  cmake: { language: "C++", manager: "CMake" },
  meson: { language: "C++", manager: "Meson" },
  autotools: { language: "C", manager: "Autotools" },
  make: { language: "C", manager: "Make" },
  bazel: { language: "C++", manager: "Bazel" },
  conan: { language: "C++", manager: "Conan" },
  vcpkg: { language: "C++", manager: "vcpkg" },
  composer: { language: "PHP", manager: "Composer" },
  go: { language: "Go", manager: "Go modules" },
  cargo: { language: "Rust", manager: "Cargo" },
  swiftpm: { language: "Swift", manager: "SwiftPM" },
  cocoapods: { language: "Swift", manager: "CocoaPods" },
  carthage: { language: "Swift", manager: "Carthage" },
  xcode: { language: "Swift", manager: "Xcode" },
  tuist: { language: "Swift", manager: "Tuist" },
  xcodegen: { language: "Swift", manager: "XcodeGen" },
  bundler: { language: "Ruby", manager: "Bundler" },
  pub: { language: "Dart", manager: "pub" },
  melos: { language: "Dart", manager: "Melos" },
  dbt: { language: "SQL", manager: "dbt" },
}

// The language a root's ecosystem is shown as, refined by its flags.
export function languageOf(root: ProjectRoot, id: EcosystemId): Language {
  const base = ECOSYSTEM_INFO[id].language
  if (base === "JavaScript" && root.flags.typescript) return "TypeScript"
  if (id === "gradle" || id === "maven")
    return root.flags.kotlin && !root.flags.javaSources ? "Kotlin" : "Java"
  if (["cmake", "meson", "autotools", "make", "bazel"].includes(id))
    return root.flags.cppSources ? "C++" : root.flags.cSources ? "C" : base
  return base
}

function dirOf(file: string): string {
  const d = path.posix.dirname(file)
  return d === "." ? "" : d
}

function depth(dir: string): number {
  return dir ? dir.split("/").length : 0
}

function skipped(dir: string): boolean {
  return dir.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment))
}

function ancestors(dir: string): string[] {
  const out: string[] = []
  let current = dir
  while (current) {
    current = dirOf(current)
    out.push(current)
    if (!current) break
  }
  return out
}

// Which ecosystem family a marker set belongs to, for member detection.
type Family =
  | "node"
  | "python"
  | "cargo"
  | "go"
  | "gradle"
  | "maven"
  | "dotnet"
  | "cmake"
  | "pub"
  | "other"

function familyOf(id: EcosystemId): Family {
  if (["pnpm", "npm", "yarn", "bun"].includes(id)) return "node"
  if (["uv", "poetry", "pipenv", "pip"].includes(id)) return "python"
  if (id === "cargo") return "cargo"
  if (id === "go") return "go"
  if (id === "gradle") return "gradle"
  if (id === "maven") return "maven"
  if (id === "dotnet") return "dotnet"
  if (id === "cmake") return "cmake"
  if (id === "pub" || id === "melos") return "pub"
  return "other"
}

const NODE_LOCKS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]

function ecosystemsIn(
  names: Set<string>,
  dirEntries: string[],
  read: Map<string, string | null>,
  dir: string
): EcosystemId[] {
  const has = (name: string) => names.has(name)
  const any = (...list: string[]) => list.some(has)
  const matching = (re: RegExp) => [...names].some((n) => re.test(n))
  const text = (name: string) => read.get(path.posix.join(dir, name)) ?? ""
  const found: EcosystemId[] = []
  // Python: one manager per root, most specific lock first.
  if (has("uv.lock")) found.push("uv")
  else if (has("poetry.lock")) found.push("poetry")
  else if (any("Pipfile.lock", "Pipfile")) found.push("pipenv")
  else if (
    matching(/^requirements.*\.txt$/) ||
    has("setup.py") ||
    (has("pyproject.toml") &&
      /\[project\]|\[tool\.poetry\]|\[build-system\]/.test(
        text("pyproject.toml")
      ))
  )
    found.push(
      has("pyproject.toml") && /\[tool\.poetry\]/.test(text("pyproject.toml"))
        ? "poetry"
        : has("pyproject.toml") && /\[tool\.uv\]/.test(text("pyproject.toml"))
          ? "uv"
          : "pip"
    )
  if (any("environment.yml", "environment.yaml")) found.push("conda")
  // JavaScript / TypeScript.
  if (any("deno.json", "deno.jsonc")) found.push("deno")
  if (has("package.json")) {
    const manager = packageManagerField(text("package.json"))
    if (has("pnpm-lock.yaml")) found.push("pnpm")
    else if (any("bun.lock", "bun.lockb")) found.push("bun")
    else if (has("yarn.lock")) found.push("yarn")
    else if (any("package-lock.json", "npm-shrinkwrap.json")) found.push("npm")
    else if (manager) found.push(manager)
    else found.push("npm")
  }
  // JVM.
  if (has("pom.xml")) found.push("maven")
  if (
    any(
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts"
    )
  )
    found.push("gradle")
  // .NET.
  if (matching(/\.(sln|slnx|csproj|fsproj|vbproj)$/) || has("global.json"))
    found.push("dotnet")
  // C / C++.
  if (has("CMakeLists.txt")) found.push("cmake")
  if (has("meson.build")) found.push("meson")
  if (any("configure.ac", "configure.in")) found.push("autotools")
  if (any("MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel")) found.push("bazel")
  if (any("conanfile.txt", "conanfile.py")) found.push("conan")
  if (has("vcpkg.json")) found.push("vcpkg")
  // PHP, Go, Rust, Ruby, Dart.
  if (has("composer.json")) found.push("composer")
  if (any("go.mod", "go.work")) found.push("go")
  if (has("Cargo.toml")) found.push("cargo")
  if (has("Gemfile")) found.push("bundler")
  if (has("pubspec.yaml")) found.push("pub")
  if (has("melos.yaml")) found.push("melos")
  if (has("dbt_project.yml")) found.push("dbt")
  // Swift / Apple.
  if (has("Package.swift")) found.push("swiftpm")
  if (has("Podfile")) found.push("cocoapods")
  if (any("Cartfile", "Cartfile.resolved")) found.push("carthage")
  if (any("Project.swift", "Tuist.swift", "Workspace.swift"))
    found.push("tuist")
  else if (
    has("project.yml") &&
    /^\s*targets:/m.test(text("project.yml")) &&
    /^\s*name:/m.test(text("project.yml"))
  )
    found.push("xcodegen")
  if (
    !found.includes("tuist") &&
    !found.includes("xcodegen") &&
    dirEntries.some((e) => /\.(xcodeproj|xcworkspace)$/.test(e))
  )
    found.push("xcode")
  // A bare Makefile builds C/C++ only when C sources sit beside it and nothing
  // else claims the directory (Makefiles are common task runners).
  if (has("Makefile") && !found.length && matching(/\.(c|cc|cpp|cxx|h|hpp)$/))
    found.push("make")
  return found
}

function packageManagerField(json: string): EcosystemId | null {
  const match = /"packageManager"\s*:\s*"(pnpm|yarn|npm|bun)@/.exec(json)
  return match ? (match[1] as EcosystemId) : null
}

// The files a detector reads (small manifests), relative to the workspace.
export function manifestsToRead(files: string[]): string[] {
  const wanted = new Set([
    "pyproject.toml",
    "package.json",
    "project.yml",
    "Cargo.toml",
    "go.mod",
    "composer.json",
    "pubspec.yaml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    ".yarnrc.yml",
    "pnpm-workspace.yaml",
  ])
  return files.filter(
    (f) =>
      wanted.has(path.posix.basename(f)) &&
      depth(dirOf(f)) <= MAX_DEPTH &&
      !skipped(dirOf(f))
  )
}

export async function detectProjects(
  files: string[],
  read: Reader
): Promise<Inventory> {
  // Group names by directory, and note directory entries (for .xcodeproj,
  // which appear as path segments of the files inside them).
  const byDir = new Map<string, Set<string>>()
  const dirEntries = new Map<string, Set<string>>()
  for (const file of files) {
    const dir = dirOf(file)
    if (!byDir.has(dir)) byDir.set(dir, new Set())
    byDir.get(dir)!.add(path.posix.basename(file))
    const segments = file.split("/")
    for (let i = 0; i < segments.length - 1; i++) {
      if (/\.(xcodeproj|xcworkspace)$/.test(segments[i])) {
        const parent = segments.slice(0, i).join("/")
        if (!dirEntries.has(parent)) dirEntries.set(parent, new Set())
        dirEntries.get(parent)!.add(segments[i])
      }
    }
  }
  for (const dir of dirEntries.keys())
    if (!byDir.has(dir)) byDir.set(dir, new Set())
  const texts = new Map<string, string | null>()
  await Promise.all(
    manifestsToRead(files).map(async (f) => texts.set(f, await read(f)))
  )

  const candidates: ProjectRoot[] = []
  for (const [dir, names] of [...byDir.entries()].sort(
    (a, b) => depth(a[0]) - depth(b[0]) || a[0].localeCompare(b[0])
  )) {
    if (depth(dir) > MAX_DEPTH || skipped(dir)) continue
    const ecosystems = ecosystemsIn(
      names,
      [...(dirEntries.get(dir) ?? [])],
      texts,
      dir
    )
    if (!ecosystems.length) continue
    const read = (name: string) => texts.get(path.posix.join(dir, name)) ?? ""
    const pkg = read("package.json")
    const gradleText = [
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
    ]
      .map(read)
      .join("\n")
    const underDir = (re: RegExp) =>
      files.some(
        (f) =>
          (dir ? f.startsWith(`${dir}/`) : true) &&
          depth(dirOf(f)) - depth(dir) <= 6 &&
          !skipped(dirOf(f)) &&
          re.test(f)
      )
    const rcYarn = read(".yarnrc.yml")
    candidates.push({
      dir,
      ecosystems,
      flags: {
        typescript:
          [...names].some((n) => /^tsconfig.*\.json$/.test(n)) ||
          /"typescript"\s*:/.test(pkg),
        kotlin:
          names.has("build.gradle.kts") ||
          names.has("settings.gradle.kts") ||
          /kotlin\(|org\.jetbrains\.kotlin/.test(gradleText) ||
          underDir(/\.kt$/),
        android:
          /com\.android\.(application|library)|id\s*\(?\s*["']com\.android/.test(
            gradleText
          ) || underDir(/AndroidManifest\.xml$/),
        flutter:
          /^\s*flutter:\s*$/m.test(read("pubspec.yaml")) ||
          /sdk:\s*flutter/.test(read("pubspec.yaml")),
        workspaces:
          /"workspaces"\s*:/.test(pkg) ||
          // pnpm-workspace.yaml also holds settings (onlyBuiltDependencies);
          // only listed packages make a monorepo.
          /^packages:\s*\n\s*-/m.test(read("pnpm-workspace.yaml")) ||
          names.has("go.work") ||
          names.has("melos.yaml") ||
          /\[workspace\]/.test(read("Cargo.toml")) ||
          /\[tool\.uv\.workspace\]/.test(read("pyproject.toml")),
        cSources: underDir(/\.(c|h)$/),
        cppSources: underDir(/\.(cc|cpp|cxx|hpp|hh|hxx)$/),
        javaSources: underDir(/\.java$/),
        yarnBerry: names.has(".yarnrc.yml"),
        yarnPnp:
          names.has(".pnp.cjs") ||
          (names.has(".yarnrc.yml") &&
            !/nodeLinker:\s*node-modules/.test(rcYarn)),
      },
      members: [],
      files: [...names].sort(),
    })
  }

  // A manifest under an ancestor root of the same family that owns the
  // install (a lockfile or workspace declaration) is a member of it.
  const roots: ProjectRoot[] = []
  for (const candidate of candidates) {
    const owners = ancestors(candidate.dir)
    const kept = candidate.ecosystems.filter((id) => {
      const family = familyOf(id)
      if (family === "other") return true
      const own = new Set(candidate.files)
      const ownsInstall =
        (family === "node" && NODE_LOCKS.some((l) => own.has(l))) ||
        (family === "python" &&
          ["uv.lock", "poetry.lock", "Pipfile.lock"].some((l) => own.has(l))) ||
        (family === "cargo" && own.has("Cargo.lock")) ||
        (family === "gradle" &&
          (own.has("settings.gradle") || own.has("settings.gradle.kts"))) ||
        (family === "pub" && own.has("melos.yaml"))
      if (ownsInstall) return true
      const owner = roots.find(
        (r) =>
          owners.includes(r.dir) &&
          r.ecosystems.some((e) => familyOf(e) === family) &&
          ownsFamily(r, family)
      )
      if (owner) {
        owner.members.push(candidate.dir)
        return false
      }
      return true
    })
    if (kept.length) roots.push({ ...candidate, ecosystems: kept })
  }

  const pins = await detectPins(roots, files, texts, read)
  return {
    roots: roots.slice(0, MAX_ROOTS),
    pins,
    truncatedRoots: Math.max(0, roots.length - MAX_ROOTS),
  }
}

function ownsFamily(root: ProjectRoot, family: Family): boolean {
  const own = new Set(root.files)
  switch (family) {
    case "node":
      return NODE_LOCKS.some((l) => own.has(l)) || root.flags.workspaces
    case "python":
      return own.has("uv.lock") || root.flags.workspaces
    case "cargo":
      return own.has("Cargo.lock") || root.flags.workspaces
    case "go":
      return own.has("go.work")
    case "gradle":
      return own.has("settings.gradle") || own.has("settings.gradle.kts")
    case "maven":
      return own.has("pom.xml")
    case "dotnet":
      return [...own].some((n) => /\.(sln|slnx)$/.test(n))
    case "cmake":
      return own.has("CMakeLists.txt")
    case "pub":
      return own.has("melos.yaml")
    default:
      return false
  }
}

const PIN_FILES: Array<{
  name: string
  tool: ToolchainPin["tool"]
}> = [
  { name: ".python-version", tool: "python" },
  { name: ".nvmrc", tool: "node" },
  { name: ".node-version", tool: "node" },
  { name: ".java-version", tool: "java" },
  { name: ".ruby-version", tool: "ruby" },
  { name: ".xcode-version", tool: "xcode" },
  { name: ".swift-version", tool: "swift" },
]

async function detectPins(
  roots: ProjectRoot[],
  files: string[],
  texts: Map<string, string | null>,
  read: Reader
): Promise<ToolchainPin[]> {
  const dirs = [...new Set(["", ...roots.map((r) => r.dir)])]
  const fileSet = new Set(files)
  const pins: ToolchainPin[] = []
  const at = (dir: string, name: string) => path.posix.join(dir, name)
  const add = (pin: ToolchainPin) => {
    if (!pin.required.trim()) return
    if (pins.some((p) => p.tool === pin.tool && p.file === pin.file)) return
    pins.push({ ...pin, required: pin.required.trim() })
  }
  for (const dir of dirs) {
    for (const { name, tool } of PIN_FILES) {
      const file = at(dir, name)
      if (!fileSet.has(file)) continue
      const value = firstLine((await read(file)) ?? "")
      if (value)
        add({ tool, required: value.replace(/^v/, ""), file, kind: "exact" })
    }
    const toolVersions = at(dir, ".tool-versions")
    if (fileSet.has(toolVersions)) {
      for (const line of ((await read(toolVersions)) ?? "").split("\n")) {
        const [plugin, version] = line.trim().split(/\s+/)
        const tool = TOOL_VERSIONS_PLUGINS[plugin ?? ""]
        if (tool && version)
          add({ tool, required: version, file: toolVersions, kind: "exact" })
      }
    }
    for (const name of ["mise.toml", ".mise.toml"]) {
      const file = at(dir, name)
      if (!fileSet.has(file)) continue
      const text = (await read(file)) ?? ""
      const tools = /\[tools\]([\s\S]*?)(\n\[|$)/.exec(text)?.[1] ?? ""
      for (const match of tools.matchAll(
        /^\s*"?([\w-]+)"?\s*=\s*"([^"]+)"/gm
      )) {
        const tool = TOOL_VERSIONS_PLUGINS[match[1]]
        if (tool) add({ tool, required: match[2], file, kind: "exact" })
      }
    }
    for (const name of ["rust-toolchain.toml", "rust-toolchain"]) {
      const file = at(dir, name)
      if (!fileSet.has(file)) continue
      const text = (await read(file)) ?? ""
      const channel =
        /channel\s*=\s*"([^"]+)"/.exec(text)?.[1] ??
        (name === "rust-toolchain" ? firstLine(text) : null)
      if (channel) add({ tool: "rust", required: channel, file, kind: "exact" })
    }
    const globalJson = at(dir, "global.json")
    if (fileSet.has(globalJson)) {
      const version = /"version"\s*:\s*"([^"]+)"/.exec(
        (await read(globalJson)) ?? ""
      )?.[1]
      if (version)
        add({
          tool: "dotnet",
          required: version,
          file: globalJson,
          kind: "exact",
        })
    }
    const goMod = at(dir, "go.mod")
    const goText = texts.get(goMod)
    if (goText) {
      const toolchain = /^toolchain\s+go([\d.]+)/m.exec(goText)?.[1]
      const go = /^go\s+([\d.]+)/m.exec(goText)?.[1]
      if (toolchain)
        add({ tool: "go", required: toolchain, file: goMod, kind: "exact" })
      else if (go)
        add({ tool: "go", required: `>=${go}`, file: goMod, kind: "range" })
    }
    const pkgFile = at(dir, "package.json")
    const pkg = texts.get(pkgFile)
    if (pkg) {
      const engines = /"engines"\s*:\s*\{([^}]*)\}/.exec(pkg)?.[1] ?? ""
      const node = /"node"\s*:\s*"([^"]+)"/.exec(engines)?.[1]
      if (node)
        add({ tool: "node", required: node, file: pkgFile, kind: "range" })
      const pm = /"packageManager"\s*:\s*"(pnpm|yarn|bun)@([^"+]+)/.exec(pkg)
      if (pm)
        add({
          tool: pm[1] as ToolchainPin["tool"],
          required: pm[2],
          file: pkgFile,
          kind: "exact",
        })
    }
    // requires-python (PEP 621) or Poetry's python constraint.
    const pyFile = at(dir, "pyproject.toml")
    const pyproject = texts.get(pyFile)
    if (pyproject) {
      const requires =
        /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ??
        /\[tool\.poetry\.dependencies\][^[]*?^\s*python\s*=\s*["']([^"']+)["']/ms.exec(
          pyproject
        )?.[1]
      if (requires)
        add({ tool: "python", required: requires, file: pyFile, kind: "range" })
    }
    const composerFile = at(dir, "composer.json")
    const composer = texts.get(composerFile)
    if (composer) {
      const php = /"require"\s*:\s*\{[^}]*"php"\s*:\s*"([^"]+)"/.exec(
        composer
      )?.[1]
      if (php)
        add({ tool: "php", required: php, file: composerFile, kind: "range" })
    }
    const pubFile = at(dir, "pubspec.yaml")
    const pub = texts.get(pubFile)
    if (pub) {
      const flutter = /^\s*flutter:\s*["']?([^"'\n]+)/m.exec(
        /environment:([\s\S]*?)(\n\S|$)/.exec(pub)?.[1] ?? ""
      )?.[1]
      if (flutter)
        add({
          tool: "flutter",
          required: flutter,
          file: pubFile,
          kind: "range",
        })
    }
    for (const name of [".fvmrc", ".fvm/fvm_config.json"]) {
      const file = at(dir, name)
      if (!fileSet.has(file)) continue
      const version = /"(?:flutter|flutterSdkVersion)"\s*:\s*"([^"]+)"/.exec(
        (await read(file)) ?? ""
      )?.[1]
      if (version)
        add({ tool: "flutter", required: version, file, kind: "exact" })
    }
    for (const name of ["build.gradle", "build.gradle.kts"]) {
      const file = at(dir, name)
      const text = texts.get(file)
      const jdk = text
        ? (/languageVersion\s*(?:\.set\()?\s*=?\s*JavaLanguageVersion\.of\((\d+)\)/.exec(
            text
          )?.[1] ?? /jvmToolchain\((\d+)\)/.exec(text)?.[1])
        : null
      if (jdk) add({ tool: "java", required: jdk, file, kind: "exact" })
    }
  }
  return pins
}

const TOOL_VERSIONS_PLUGINS: Record<string, ToolchainPin["tool"]> = {
  python: "python",
  nodejs: "node",
  node: "node",
  java: "java",
  ruby: "ruby",
  rust: "rust",
  golang: "go",
  go: "go",
  dotnet: "dotnet",
  "dotnet-core": "dotnet",
  flutter: "flutter",
  dart: "dart",
  php: "php",
  pnpm: "pnpm",
  yarn: "yarn",
  bun: "bun",
  cmake: "cmake",
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#")) ?? ""
  )
}
