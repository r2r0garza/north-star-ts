import { describe, expect, it } from "vitest"
import { detectProjects, languageOf } from "./inventory"
import { classifyIgnored } from "./ignored"

function reader(files: Record<string, string>) {
  return async (file: string) => files[file] ?? null
}

async function detect(files: Record<string, string>) {
  return detectProjects(Object.keys(files), reader(files))
}

describe("detectProjects", () => {
  it("treats pnpm workspace packages as members of the root install", async () => {
    const inv = await detect({
      "package.json": "{}",
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/a/package.json": "{}",
      "packages/b/package.json": "{}",
    })
    expect(inv.roots.map((r) => [r.dir, r.ecosystems])).toEqual([
      ["", ["pnpm"]],
    ])
    expect(inv.roots[0].members.sort()).toEqual(["packages/a", "packages/b"])
    expect(inv.roots[0].flags.workspaces).toBe(true)
  })

  it("doesn't call a settings-only pnpm-workspace.yaml a monorepo", async () => {
    const inv = await detect({
      "package.json": "{}",
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml":
        "packages: []\nonlyBuiltDependencies:\n  - esbuild\n",
    })
    expect(inv.roots[0].flags.workspaces).toBe(false)
  })

  it("keeps separately locked projects as their own roots", async () => {
    const inv = await detect({
      "api/pyproject.toml": "[project]\nname='api'\n",
      "api/uv.lock": "",
      "web/package.json": "{}",
      "web/package-lock.json": "{}",
      "tools/Cargo.toml": "[package]\n",
      "tools/Cargo.lock": "",
    })
    expect(
      inv.roots.map((r) => `${r.dir}:${r.ecosystems.join(",")}`).sort()
    ).toEqual(["api:uv", "tools:cargo", "web:npm"])
  })

  it("folds Cargo, Gradle, Maven, and .NET members into their root", async () => {
    const inv = await detect({
      "Cargo.toml": "[workspace]\nmembers=['crates/*']\n",
      "Cargo.lock": "",
      "crates/a/Cargo.toml": "[package]\n",
      "jvm/settings.gradle.kts": "include(':app')\n",
      "jvm/app/build.gradle.kts": "",
      "svc/pom.xml": "<project/>",
      "svc/core/pom.xml": "<project/>",
      "net/App.sln": "",
      "net/App/App.csproj": "<Project/>",
    })
    const byDir = Object.fromEntries(inv.roots.map((r) => [r.dir, r]))
    expect(Object.keys(byDir).sort()).toEqual(["", "jvm", "net", "svc"])
    expect(byDir[""].members).toEqual(["crates/a"])
    expect(byDir.jvm.members).toEqual(["jvm/app"])
    expect(byDir.svc.members).toEqual(["svc/core"])
    expect(byDir.net.members).toEqual(["net/App"])
  })

  it("labels languages from sources and plugins", async () => {
    const inv = await detect({
      "settings.gradle.kts": "",
      "app/src/main/kotlin/Main.kt": "",
      "native/CMakeLists.txt": "",
      "native/src/a.cpp": "",
      "c/Makefile": "",
      "c/main.c": "",
      "web/package.json": '{"devDependencies": {"typescript": "5"}}',
      "web/package-lock.json": "",
    })
    const lang = (dir: string) => {
      const root = inv.roots.find((r) => r.dir === dir)!
      return languageOf(root, root.ecosystems[0])
    }
    expect(lang("")).toBe("Kotlin")
    expect(lang("native")).toBe("C++")
    expect(lang("c")).toBe("C")
    expect(lang("web")).toBe("TypeScript")
  })

  it("detects Apple, Ruby, PHP, Go, Dart, dbt, and XcodeGen projects", async () => {
    const inv = await detect({
      "ios/Podfile": "",
      "ios/App.xcodeproj/project.pbxproj": "",
      "gen/project.yml": "name: App\ntargets:\n  App: {}\n",
      "rb/Gemfile": "",
      "php/composer.json": "{}",
      "go/go.mod": "module x\n",
      "dart/pubspec.yaml":
        "name: a\ndependencies:\n  flutter:\n    sdk: flutter\n",
      "dbt/dbt_project.yml": "",
    })
    const eco = Object.fromEntries(inv.roots.map((r) => [r.dir, r.ecosystems]))
    expect(eco.ios).toEqual(["cocoapods", "xcode"])
    expect(eco.gen).toEqual(["xcodegen"])
    expect(eco.rb).toEqual(["bundler"])
    expect(eco.php).toEqual(["composer"])
    expect(eco.go).toEqual(["go"])
    expect(eco.dart).toEqual(["pub"])
    expect(eco.dbt).toEqual(["dbt"])
    expect(inv.roots.find((r) => r.dir === "dart")!.flags.flutter).toBe(true)
  })

  it("skips vendored code and fixtures", async () => {
    const inv = await detect({
      "package.json": "{}",
      "node_modules/x/package.json": "{}",
      "vendor/lib/composer.json": "{}",
      "test/fixtures/app/package.json": "{}",
    })
    expect(inv.roots.map((r) => r.dir)).toEqual([""])
  })

  it("reads toolchain pins from every common place", async () => {
    const inv = await detect({
      "package.json":
        '{"engines": {"node": ">=20"}, "packageManager": "pnpm@9.12.0"}',
      "pnpm-lock.yaml": "",
      ".python-version": "3.12\n",
      ".tool-versions": "ruby 3.3.1\ngolang 1.22.3\n",
      "mise.toml": '[tools]\njava = "21"\n',
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.79.0"\n',
      "global.json": '{"sdk": {"version": "8.0.100"}}',
      "go.mod": "module x\n\ngo 1.21\n\ntoolchain go1.22.4\n",
      ".fvmrc": '{"flutter": "3.22.0"}',
      "build.gradle.kts": "kotlin { jvmToolchain(17) }\n",
      "composer.json": '{"require": {"php": "^8.2"}}',
    })
    const pins = Object.fromEntries(
      inv.pins.map((p) => [`${p.tool}@${p.file}`, p.required])
    )
    expect(pins).toMatchObject({
      "node@package.json": ">=20",
      "pnpm@package.json": "9.12.0",
      "python@.python-version": "3.12",
      "ruby@.tool-versions": "3.3.1",
      "go@go.mod": "1.22.4",
      "java@mise.toml": "21",
      "rust@rust-toolchain.toml": "1.79.0",
      "dotnet@global.json": "8.0.100",
      "flutter@.fvmrc": "3.22.0",
      "java@build.gradle.kts": "17",
      "php@composer.json": "^8.2",
    })
  })
})

describe("classifyIgnored", () => {
  const roots = [
    {
      dir: "",
      ecosystems: ["pnpm", "composer"],
      flags: {},
      members: [],
      files: [],
    },
    { dir: "api", ecosystems: ["uv"], flags: {}, members: [], files: [] },
  ] as unknown as Parameters<typeof classifyIgnored>[1]

  it("sorts environments, config, databases, outputs, and noise", () => {
    const out = classifyIgnored(
      [
        "node_modules/",
        "api/.venv/",
        "vendor/",
        ".env.local",
        ".env.example",
        "local.properties",
        "db.sqlite3",
        "dist/",
        "api/target/",
        ".DS_Store",
        "api/__pycache__/",
        "notes/",
      ],
      roots
    )
    const by = Object.fromEntries(
      out.map((e) => [
        e.path,
        `${e.class}${e.ecosystem ? `:${e.ecosystem}` : ""}${e.root ? `@${e.root}` : ""}`,
      ])
    )
    expect(by).toEqual({
      node_modules: "environment:pnpm",
      "api/.venv": "environment:uv@api",
      vendor: "environment:composer",
      ".env.local": "local-config",
      ".env.example": "unknown",
      "local.properties": "local-config",
      "db.sqlite3": "database",
      dist: "build-output",
      "api/target": "build-output@api",
      ".DS_Store": "noise",
      "api/__pycache__": "noise@api",
      notes: "unknown",
    })
  })
})
