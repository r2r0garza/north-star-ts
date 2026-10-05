// The evaluation corpus for workspace analysis (plan 106.11): small
// synthetic repositories, each with the findings an expert would expect and
// outcomes that must never happen. The harness (fixtures.test.ts) builds each
// one as a real Git repository in a temp directory and fakes the project
// tools, so results don't depend on what the test machine has installed.

export interface Fixture {
  name: string
  // Committed files.
  tracked: Record<string, string>
  // Created after the commit (must be ignored by a tracked .gitignore).
  ignored?: Record<string, string>
  // Symlinks created after the commit: path -> target (relative).
  symlinks?: Record<string, string>
  // Files older than everything else (for staleness checks): set mtime back.
  aged?: string[]
  // Tool versions by executable; null = not installed. Unlisted tools are
  // installed at a high version; version managers are absent unless listed.
  tools?: Record<string, string | null>
  // Shell probe results by pattern; unlisted probes pass.
  shell?: Array<{ match: RegExp; ok: boolean; output?: string }>
  // Analyze this subfolder of the repository instead of its root.
  workspace?: string
  noGit?: boolean
  noCommit?: boolean
  // Files modified after the commit (dirty tree).
  dirty?: Record<string, string>
  // Analyze a linked worktree of the repository.
  linkedWorktree?: boolean
  settings?: {
    linkPaths?: string[]
    steps?: Array<{ command: string; cwd: string }>
    generatedFiles?: Array<{ paths: string[]; command: string }>
  }
  expect: {
    open?: string[]
    resolved?: string[]
    absent?: string[]
    fixKinds?: Record<
      string,
      "apply-settings" | "run-command" | "run-checks" | "manual"
    >
    // Commands a finding's fix contains (run-command commands, or the setup
    // steps / regeneration commands its settings patch saves), in order.
    commands?: Record<string, string[]>
    confidence?: Record<string, "verified" | "likely" | "guess">
    severity?: Record<string, "blocker" | "warning" | "info">
    // Paths no finding may ever propose linking.
    forbidLinks?: string[]
    // Commands no probe may have executed during analysis.
    forbidExecuted?: RegExp[]
    // Settings after applying every default-selected settings fix.
    settingsAfter?: {
      linkPaths?: string[]
      steps?: string[] // "cwd|command"
      generated?: string[] // commands
    }
  }
}

const pkg = (json: Record<string, unknown>) => JSON.stringify(json, null, 2)

export const FIXTURES: Fixture[] = [
  // ── Python ────────────────────────────────────────────────────────────────
  {
    name: "pip requirements, no venv",
    tracked: {
      ".gitignore": ".venv/\n__pycache__/\n",
      "requirements.txt": "requests==2.32.0\n",
      "app.py": "print('hi')\n",
    },
    expect: {
      open: ["main-env:.:pip", "worktree-env:setup:.:pip"],
      fixKinds: {
        "main-env:.:pip": "run-command",
        "worktree-env:setup:.:pip": "apply-settings",
      },
      commands: {
        "main-env:.:pip": [
          "python3 -m venv .venv",
          ".venv/bin/python -m pip install --upgrade pip",
          ".venv/bin/python -m pip install -r requirements.txt",
        ],
        "worktree-env:setup:.:pip": [
          "python3 -m venv .venv",
          ".venv/bin/python -m pip install --upgrade pip",
          ".venv/bin/python -m pip install -r requirements.txt",
        ],
      },
      severity: { "main-env:.:pip": "blocker" },
    },
  },
  {
    name: "pip venv present, not editable",
    tracked: {
      ".gitignore": ".venv/\n",
      "requirements.txt": "requests==2.32.0\n",
      "app.py": "print('hi')\n",
    },
    ignored: {
      ".venv/pyvenv.cfg": "home = /usr/bin\n",
      ".venv/lib/python3.12/site-packages/requests-2.32.0.dist-info/METADATA":
        "Name: requests\n",
    },
    expect: {
      open: ["worktree-env:link:.venv"],
      resolved: ["main-env:.:pip"],
      fixKinds: { "worktree-env:link:.venv": "apply-settings" },
      confidence: { "worktree-env:link:.venv": "verified" },
      settingsAfter: { linkPaths: [".venv"] },
    },
  },
  {
    name: "uv project with editable install",
    tracked: {
      ".gitignore": ".venv/\n",
      "pyproject.toml":
        '[project]\nname = "shop"\nversion = "0.1.0"\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
      "uv.lock": "version = 1\n",
      "src/shop/__init__.py": "",
    },
    ignored: {
      ".venv/pyvenv.cfg": "home = /usr/bin\n",
      ".venv/lib/python3.12/site-packages/__editable__.shop-0.1.0.pth":
        "import __editable___shop_0_1_0_finder\n",
    },
    expect: {
      open: ["worktree-env:setup:.:uv"],
      resolved: ["main-env:.:uv"],
      commands: { "worktree-env:setup:.:uv": ["uv sync"] },
      confidence: { "worktree-env:setup:.:uv": "verified" },
      forbidLinks: [".venv"],
      settingsAfter: { steps: ["|uv sync"], linkPaths: [] },
    },
  },
  {
    name: "user linked an editable venv",
    tracked: {
      ".gitignore": ".venv/\n",
      "pyproject.toml":
        '[project]\nname = "shop"\n[build-system]\nrequires = ["hatchling"]\n',
      "uv.lock": "version = 1\n",
    },
    ignored: {
      ".venv/pyvenv.cfg": "home = /usr/bin\n",
      ".venv/lib/python3.12/site-packages/shop-0.1.0.dist-info/direct_url.json":
        '{"url": "file://{{root}}", "dir_info": {"editable": true}}',
    },
    settings: { linkPaths: [".venv"] },
    expect: {
      open: ["worktree-env:setup:.:uv"],
      forbidLinks: [".venv"],
      settingsAfter: { linkPaths: [], steps: ["|uv sync"] },
    },
  },
  {
    name: "pyproject needs 3.11 but python3 is Apple's 3.9, and a 3.9 venv exists",
    tracked: {
      ".gitignore": ".venv/\n",
      "pyproject.toml":
        '[project]\nname = "agentic"\nrequires-python = ">=3.11"\n\n[project.optional-dependencies]\ndev = ["pytest>=8.0"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
      "src/agentic/__init__.py": "",
    },
    ignored: { ".venv/pyvenv.cfg": "home = /usr/bin\nversion = 3.9.6\n" },
    tools: { python3: "Python 3.9.6", "python3.12": "Python 3.12.14" },
    expect: {
      open: ["main-env:.:pip", "worktree-env:setup:.:pip"],
      absent: ["toolchain:python:."],
      // The setup will install it editable: don't link the (broken) venv.
      forbidLinks: [".venv"],
      settingsAfter: {
        // An editable install: each worktree reuses this checkout's
        // packages through a thin venv of its own.
        steps: ["|reuse .venv packages from the main checkout"],
      },
      severity: { "main-env:.:pip": "blocker" },
      commands: {
        "main-env:.:pip": [
          "python3.12 -m venv --clear .venv",
          ".venv/bin/python -m pip install --upgrade pip",
          ".venv/bin/python -m pip install -e '.[dev]'",
        ],
      },
    },
  },
  {
    name: "pyproject needs 3.11 and only Apple's 3.9 is installed",
    tracked: {
      ".gitignore": ".venv/\n",
      "pyproject.toml":
        '[project]\nname = "agentic"\nrequires-python = ">=3.11"\n[build-system]\nrequires = ["hatchling"]\n',
    },
    tools: { python3: "Python 3.9.6" },
    expect: {
      open: ["toolchain:python:.", "main-env:.:pip"],
      severity: { "toolchain:python:.": "blocker" },
      // uv is installed (the fakes' default), so it can install the Python.
      commands: { "toolchain:python:.": ["uv python install 3.11"] },
    },
  },
  {
    name: "poetry lock drifted",
    tracked: {
      ".gitignore": ".venv/\n",
      "pyproject.toml": '[tool.poetry]\nname = "svc"\n',
      "poetry.lock": "# lock\n",
    },
    ignored: { ".venv/pyvenv.cfg": "home = /usr/bin\n" },
    shell: [
      {
        match: /poetry check --lock/,
        ok: false,
        output:
          "pyproject.toml changed significantly since poetry.lock was last generated. Run `poetry lock` to fix the lock file.",
      },
    ],
    expect: {
      open: ["main-env:.:poetry"],
      severity: { "main-env:.:poetry": "blocker" },
      commands: { "main-env:.:poetry": ["poetry install"] },
      confidence: { "main-env:.:poetry": "verified" },
    },
  },
  // ── JavaScript / TypeScript ───────────────────────────────────────────────
  {
    name: "pnpm monorepo with workspace packages",
    tracked: {
      ".gitignore": "node_modules/\n",
      "package.json": pkg({
        name: "mono",
        private: true,
        devDependencies: { typescript: "5.6.0" },
      }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "tsconfig.json": "{}",
      "packages/ui/package.json": pkg({
        name: "@mono/ui",
        dependencies: { react: "18.0.0" },
      }),
      "packages/app/package.json": pkg({
        name: "@mono/app",
        dependencies: { "@mono/ui": "workspace:*" },
      }),
      "packages/app/src/routeTree.gen.ts":
        "/* eslint-disable */\n// This file is auto-generated by TanStack Router\nexport const routeTree = {}\n",
      "packages/app/src/main.ts": "export {}\n",
    },
    ignored: {
      "node_modules/.modules.yaml": "layoutVersion: 5\n",
      "node_modules/typescript/package.json": "{}",
      "packages/ui/node_modules/react/package.json": "{}",
    },
    symlinks: { "packages/app/node_modules/@mono/ui": "../../../ui" },
    expect: {
      open: ["worktree-env:setup:.:pnpm", "generated:lock:pnpm-lock.yaml"],
      commands: {
        "worktree-env:setup:.:pnpm": ["pnpm install --frozen-lockfile"],
        "generated:lock:pnpm-lock.yaml": ["pnpm install --lockfile-only"],
      },
      forbidLinks: [
        "node_modules",
        "packages/ui/node_modules",
        "packages/app/node_modules",
      ],
      absent: ["main-env:packages/ui:npm", "main-env:packages/app:npm"],
      settingsAfter: {
        steps: ["|pnpm install --frozen-lockfile"],
        generated: ["pnpm install --lockfile-only", "npx tsr generate"],
      },
    },
  },
  {
    name: "single-package npm app with node_modules",
    tracked: {
      ".gitignore": "node_modules/\n",
      "package.json": pkg({
        name: "app",
        dependencies: { "left-pad": "1.3.0" },
      }),
      "package-lock.json": "{}",
      "index.js": "require('left-pad')\n",
    },
    ignored: {
      "node_modules/left-pad/package.json": "{}",
      "node_modules/.package-lock.json": "{}",
    },
    expect: {
      open: ["worktree-env:link:node_modules"],
      resolved: ["main-env:.:npm"],
      settingsAfter: { linkPaths: ["node_modules"] },
    },
  },
  {
    name: "Python API and Node web in subfolders",
    tracked: {
      ".gitignore": "node_modules/\n.venv/\n",
      "api/requirements.txt": "fastapi\n",
      "api/main.py": "",
      "web/package.json": pkg({ name: "web", dependencies: { vite: "5" } }),
      "web/package-lock.json": "{}",
    },
    expect: {
      open: [
        "main-env:api:pip",
        "main-env:web:npm",
        "worktree-env:setup:api:pip",
        "worktree-env:setup:web:npm",
      ],
      settingsAfter: {
        steps: [
          "api|python3 -m venv .venv",
          "api|.venv/bin/python -m pip install --upgrade pip",
          "api|.venv/bin/python -m pip install -r requirements.txt",
          "web|npm ci",
        ],
      },
    },
  },
  {
    name: "OpenAPI client generated by a package script",
    tracked: {
      ".gitignore": "node_modules/\n",
      "package.json": pkg({
        name: "app",
        scripts: {
          "gen:api":
            "openapi-generator-cli generate -i spec.yaml -g typescript-fetch -o src/api/generated",
        },
      }),
      "package-lock.json": "{}",
      "spec.yaml": "openapi: 3.0.0\n",
      "src/api/generated/apis.ts":
        "/* tslint:disable */\n/**\n * Petstore\n * NOTE: This class is auto generated by OpenAPI Generator. Do not edit the class manually.\n */\nexport {}\n",
      "src/api/generated/models.ts": "// @generated\nexport {}\n",
      "src/index.ts": "export {}\n",
    },
    ignored: { "node_modules/.package-lock.json": "{}" },
    expect: {
      open: ["generated:marked:.:src/api/generated/**"],
      commands: {
        "generated:marked:.:src/api/generated/**": ["npm run gen:api"],
      },
    },
  },
  {
    name: "Prisma client and protobuf from tool configs",
    tracked: {
      ".gitignore": "node_modules/\n",
      "package.json": pkg({
        name: "svc",
        scripts: { "db:generate": "prisma generate" },
      }),
      "package-lock.json": "{}",
      "prisma/schema.prisma":
        'generator client {\n  provider = "prisma-client-js"\n  output   = "../src/generated/prisma"\n}\n',
      "src/generated/prisma/index.ts": "export {}\n",
      "src/generated/prisma/client.ts": "export {}\n",
      "buf.gen.yaml":
        "version: v2\nplugins:\n  - remote: buf.build/protocolbuffers/go\n    out: gen/go\n",
      "gen/go/user.pb.go":
        "// Code generated by protoc-gen-go. DO NOT EDIT.\npackage gen\n",
    },
    expect: {
      open: ["generated:prisma:.", "generated:protobuf:."],
      commands: {
        "generated:prisma:.": ["npm run db:generate"],
        "generated:protobuf:.": ["buf generate"],
      },
      confidence: { "generated:prisma:.": "verified" },
    },
  },
  {
    name: "ignored local configuration",
    tracked: {
      ".gitignore": ".env.local\n.env.example.local\n",
      "package.json": pkg({ name: "x" }),
      "package-lock.json": "{}",
    },
    ignored: { ".env.local": "SECRET=do-not-read\n" },
    expect: {
      open: ["local-config:.env.local"],
      fixKinds: { "local-config:.env.local": "apply-settings" },
      settingsAfter: { linkPaths: [".env.local"] },
    },
  },
  {
    name: "workspace is a subfolder of the repository",
    tracked: {
      ".gitignore": "node_modules/\n",
      "README.md": "# mono\n",
      "apps/site/package.json": pkg({ name: "site" }),
      "apps/site/package-lock.json": "{}",
    },
    workspace: "apps/site",
    expect: { open: ["main-env:.:npm", "git-isolation:parallel"] },
  },
  {
    name: "workspace is a linked worktree",
    tracked: {
      ".gitignore": "",
      "go.mod": "module x\n\ngo 1.22\n",
      "main.go": "package main\n",
    },
    linkedWorktree: true,
    expect: {
      open: ["project-state:linked-worktree", "git-isolation:parallel"],
    },
  },
  {
    name: "dirty tree",
    tracked: {
      ".gitignore": "",
      "go.mod": "module x\n\ngo 1.22\n",
      "main.go": "package main\n",
    },
    dirty: { "main.go": "package main\n// wip\n" },
    expect: {
      open: ["project-state:dirty"],
      fixKinds: { "project-state:dirty": "manual" },
    },
  },
  {
    name: "unborn HEAD",
    tracked: { "go.mod": "module x\n" },
    noCommit: true,
    expect: {
      open: ["git-isolation:unborn"],
      absent: ["git-isolation:parallel"],
    },
  },
  {
    name: "not a Git repository",
    tracked: { "go.mod": "module x\n\ngo 1.22\n" },
    noGit: true,
    expect: {
      open: ["git-isolation:not-a-repo"],
      fixKinds: { "git-isolation:not-a-repo": "manual" },
      absent: ["git-isolation:parallel"],
    },
  },
  // ── Java / Kotlin ─────────────────────────────────────────────────────────
  {
    name: "Maven with the wrapper",
    tracked: {
      ".gitignore": "target/\n",
      "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n",
      mvnw: "#!/bin/sh\n",
      "src/main/java/App.java": "class App {}\n",
    },
    ignored: { "target/classes/App.class": "x" },
    expect: {
      open: ["main-env:.:maven"],
      fixKinds: { "main-env:.:maven": "run-checks" },
      commands: { "main-env:.:maven": ["./mvnw -B -q -o validate"] },
      forbidExecuted: [/mvnw|mvn /],
      forbidLinks: ["target"],
    },
  },
  {
    name: "Gradle multi-module with OpenAPI into src",
    tracked: {
      ".gitignore": "build/\n.gradle/\n",
      "settings.gradle.kts": 'include(":app")\n',
      gradlew: "#!/bin/sh\n",
      "app/build.gradle.kts":
        'plugins { id("org.openapi.generator") version "7.0.0" }\n',
      "app/src/main/java/gen/Api.java":
        "/*\n * This file was automatically generated by OpenAPI Generator\n * DO NOT EDIT\n */\nclass Api {}\n",
      "app/src/main/java/gen/Model.java":
        "// DO NOT EDIT: auto-generated\nclass Model {}\n",
      "app/src/main/java/App.java": "class App {}\n",
    },
    expect: {
      open: ["generated:marked:.:app/src/main/java/gen/**"],
      commands: {
        "generated:marked:.:app/src/main/java/gen/**": [
          "./gradlew openApiGenerate",
        ],
      },
      forbidExecuted: [/gradlew/],
    },
  },
  {
    name: "Kotlin Android app with local.properties and a pinned JDK",
    tracked: {
      ".gitignore": "local.properties\nbuild/\n.gradle/\n",
      "settings.gradle.kts": 'include(":app")\n',
      "build.gradle.kts": "kotlin { jvmToolchain(17) }\n",
      "app/build.gradle.kts": 'plugins { id("com.android.application") }\n',
      "app/src/main/AndroidManifest.xml": "<manifest/>\n",
      "app/src/main/kotlin/Main.kt": "fun main() {}\n",
    },
    ignored: { "local.properties": "sdk.dir=/Users/me/Library/Android/sdk\n" },
    tools: { java: 'openjdk version "21.0.2" 2024-01-16' },
    expect: {
      open: [
        "local-config:local.properties",
        "toolchain:pin:java:build.gradle.kts",
      ],
      settingsAfter: { linkPaths: ["local.properties"] },
    },
  },
  // ── C# ────────────────────────────────────────────────────────────────────
  {
    name: ".NET solution with tools and designer files",
    tracked: {
      ".gitignore": "bin/\nobj/\n",
      "App.sln": "Microsoft Visual Studio Solution File\n",
      "global.json": '{ "sdk": { "version": "8.0.100" } }',
      ".config/dotnet-tools.json": '{ "tools": {} }',
      "App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
      "App/Form1.Designer.cs": "namespace App { partial class Form1 {} }\n",
      "App/Form1.cs": "namespace App { partial class Form1 {} }\n",
    },
    ignored: {
      "App/obj/project.assets.json": "{}",
      "App/bin/Debug/App.dll": "x",
    },
    tools: { dotnet: "8.0.100" },
    expect: {
      open: ["generated:dotnet:."],
      commands: { "generated:dotnet:.": ["dotnet build"] },
      forbidLinks: ["App/obj", "App/bin"],
      absent: ["toolchain:pin:dotnet:global.json"],
    },
  },
  // ── C / C++ ───────────────────────────────────────────────────────────────
  {
    name: "CMake presets with a stale cache from another checkout",
    tracked: {
      ".gitignore": "build/\n",
      "CMakeLists.txt":
        "cmake_minimum_required(VERSION 3.20)\nproject(app CXX)\n",
      "CMakePresets.json":
        '{ "version": 3, "configurePresets": [ { "name": "base", "hidden": true }, { "name": "dev", "inherits": "base" } ] }',
      "vcpkg.json": '{ "dependencies": ["fmt"] }',
      "src/main.cpp": "int main() {}\n",
      "proto/user.pb.cc":
        "// Generated by the protocol buffer compiler.  DO NOT EDIT!\n",
      "proto/user.pb.h":
        "// Generated by the protocol buffer compiler.  DO NOT EDIT!\n",
    },
    ignored: {
      "build/CMakeCache.txt":
        "CMAKE_HOME_DIRECTORY:INTERNAL=/Users/someone/elsewhere\n",
    },
    expect: {
      open: ["main-env:.:cmake", "build-cost:.", "generated:protobuf:."],
      severity: { "main-env:.:cmake": "blocker" },
      commands: { "main-env:.:cmake": ["cmake --preset dev"] },
      forbidLinks: ["build"],
    },
  },
  {
    name: "Autotools with an untracked configure",
    tracked: {
      ".gitignore": "configure\nconfig.status\n",
      "configure.ac": "AC_INIT([app], [1.0])\n",
      "Makefile.am": "bin_PROGRAMS = app\n",
      "src/main.c": "int main(void) { return 0; }\n",
    },
    expect: {
      open: ["main-env:.:autotools"],
      commands: { "main-env:.:autotools": ["autoreconf -i", "./configure"] },
    },
  },
  // ── PHP ───────────────────────────────────────────────────────────────────
  {
    name: "Laravel with vendor and .env",
    tracked: {
      ".gitignore": "vendor/\n.env\n",
      "composer.json": pkg({ require: { php: "^8.2" } }),
      "composer.lock": "{}",
      artisan: "#!/usr/bin/env php\n",
      "app/Models/User.php": "<?php\n",
    },
    ignored: { "vendor/autoload.php": "<?php\n", ".env": "APP_KEY=secret\n" },
    tools: { php: "PHP 8.3.4 (cli)" },
    expect: {
      open: [
        "worktree-env:setup:.:composer",
        "local-config:.env",
        "generated:lock:composer.lock",
      ],
      commands: {
        "worktree-env:setup:.:composer": ["composer install --no-interaction"],
      },
      forbidLinks: ["vendor"],
      settingsAfter: {
        linkPaths: [".env"],
        steps: ["|composer install --no-interaction"],
      },
    },
  },
  // ── Go ────────────────────────────────────────────────────────────────────
  {
    name: "Go workspace with go:generate",
    tracked: {
      ".gitignore": "",
      "go.work": "go 1.22\n\nuse (\n\t./svc/a\n\t./svc/b\n)\n",
      "svc/a/go.mod": "module a\n\ngo 1.22\n",
      "svc/a/go.sum": "",
      "svc/b/go.mod": "module b\n\ngo 1.22\n",
      "svc/a/kind.go":
        "package a\n\n//go:generate stringer -type=Kind\ntype Kind int\n",
      "svc/a/kind_string.go":
        '// Code generated by "stringer -type=Kind"; DO NOT EDIT.\n\npackage a\n',
    },
    expect: {
      open: ["generated:marked:.:svc/a/kind_string.go"],
      commands: {
        "generated:marked:.:svc/a/kind_string.go": ["go generate ./..."],
      },
      absent: ["worktree-env:setup:.:go"],
    },
  },
  // ── Rust ──────────────────────────────────────────────────────────────────
  {
    name: "Rust workspace with a toolchain mismatch",
    tracked: {
      ".gitignore": "target/\n",
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
      "Cargo.lock": "version = 3\n",
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.79.0"\n',
      "crates/core/Cargo.toml": '[package]\nname = "core"\n',
      "crates/core/src/lib.rs": "",
    },
    ignored: { "target/debug/.fingerprint/x": "x" },
    tools: {
      rustc: "rustc 1.80.1 (3f5fd8dd4 2024-08-06)",
      rustup: "rustup 1.27.1",
    },
    expect: {
      open: [
        "toolchain:pin:rust:rust-toolchain.toml",
        "build-cost:.",
        "generated:lock:Cargo.lock",
      ],
      commands: {
        "toolchain:pin:rust:rust-toolchain.toml": [
          "rustup toolchain install 1.79.0",
        ],
      },
      forbidLinks: ["target"],
      absent: ["main-env:crates/core:cargo"],
    },
  },
  // ── Swift ─────────────────────────────────────────────────────────────────
  {
    name: "SwiftPM package",
    tracked: {
      ".gitignore": ".build/\n",
      "Package.swift": "// swift-tools-version:5.9\n",
      "Package.resolved": "{}",
      "Sources/App/main.swift": "",
    },
    expect: {
      open: ["main-env:.:swiftpm"],
      commands: { "main-env:.:swiftpm": ["swift package resolve"] },
      forbidLinks: [".build"],
    },
  },
  {
    name: "CocoaPods app with a stale sandbox",
    tracked: {
      ".gitignore": "Pods/\n",
      Podfile: "platform :ios, '17.0'\n",
      "Podfile.lock": "PODS:\n  - Alamofire (5.9.0)\n",
      "App.xcodeproj/project.pbxproj": "// !$*UTF8*$!\n",
    },
    ignored: { "Pods/Manifest.lock": "PODS:\n  - Alamofire (5.8.0)\n" },
    expect: {
      open: ["main-env:.:cocoapods", "worktree-env:setup:.:cocoapods"],
      severity: { "main-env:.:cocoapods": "blocker" },
      forbidLinks: ["Pods"],
    },
  },
  {
    name: "XcodeGen project that's ignored",
    tracked: {
      ".gitignore": "*.xcodeproj\n",
      "project.yml": "name: App\ntargets:\n  App:\n    type: application\n",
      "Sources/App.swift": "",
    },
    ignored: { "App.xcodeproj/project.pbxproj": "// !$*UTF8*$!\n" },
    expect: {
      open: ["worktree-env:setup:.:xcodegen"],
      commands: { "worktree-env:setup:.:xcodegen": ["xcodegen generate"] },
      forbidLinks: ["App.xcodeproj"],
    },
  },
  // ── Ruby ──────────────────────────────────────────────────────────────────
  {
    name: "Rails app with a path gem",
    tracked: {
      ".gitignore": "vendor/bundle/\nconfig/master.key\n",
      Gemfile:
        "source 'https://rubygems.org'\ngem 'rails'\ngem 'engine', path: 'engines/engine'\n",
      "Gemfile.lock": "GEM\n",
      "bin/rails": "#!/usr/bin/env ruby\n",
      "db/schema.rb":
        "ActiveRecord::Schema[7.1].define(version: 2024_01_01) do\nend\n",
      "app/models/user.rb": "class User; end\n",
    },
    ignored: {
      "config/master.key": "abc123",
      "vendor/bundle/ruby/3.3.0/gems/rails/x": "x",
    },
    expect: {
      open: [
        "local-config:config/master.key",
        "worktree-env:setup:.:bundler",
        "generated:rails-schema:.",
      ],
      commands: {
        "worktree-env:setup:.:bundler": ["bundle install"],
        "generated:rails-schema:.": ["bin/rails db:schema:dump"],
      },
      confidence: { "generated:rails-schema:.": "likely" },
      forbidLinks: ["vendor/bundle"],
      forbidExecuted: [/bundle check/],
    },
  },
  // ── SQL ───────────────────────────────────────────────────────────────────
  {
    name: "Django with migrations and a SQLite dev database",
    tracked: {
      ".gitignore": ".venv/\ndb.sqlite3\n",
      "requirements.txt": "django\n",
      "manage.py": "#!/usr/bin/env python\n",
      "shop/migrations/0001_initial.py": "",
      "shop/migrations/0002_price.py": "",
    },
    ignored: { "db.sqlite3": "SQLite format 3" },
    expect: {
      open: [
        "database:migrations:shop/migrations",
        "database:sqlite:db.sqlite3",
      ],
      commands: {
        "database:sqlite:db.sqlite3": [".venv/bin/python manage.py migrate"],
      },
      forbidLinks: ["db.sqlite3"],
    },
  },
  {
    name: "Prisma migrations and a dbt project",
    tracked: {
      ".gitignore": "node_modules/\ndbt_packages/\n",
      "package.json": pkg({ name: "data" }),
      "package-lock.json": "{}",
      "prisma/schema.prisma":
        'generator client {\n  provider = "prisma-client-js"\n}\n',
      "prisma/migrations/20240101000000_init/migration.sql":
        "CREATE TABLE a (id int);\n",
      "analytics/dbt_project.yml": "name: analytics\n",
      "analytics/packages.yml": "packages:\n  - package: dbt-labs/dbt_utils\n",
      "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n",
    },
    expect: {
      open: ["main-env:analytics:dbt", "database:shared:docker-compose.yml"],
      commands: { "main-env:analytics:dbt": ["dbt deps"] },
      absent: ["database:migrations:prisma/migrations/20240101000000_init"],
    },
  },
  // ── Dart ──────────────────────────────────────────────────────────────────
  {
    name: "Flutter app with build_runner and FVM",
    tracked: {
      ".gitignore": ".dart_tool/\n",
      "pubspec.yaml":
        "name: app\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  build_runner: ^2.4.0\n",
      "pubspec.lock": "packages: {}\n",
      ".fvmrc": '{ "flutter": "3.22.0" }',
      "lib/model.dart": "part 'model.g.dart';\n",
      "lib/model.g.dart": "// GENERATED CODE - DO NOT MODIFY BY HAND\n",
      "lib/model.freezed.dart": "// GENERATED CODE - DO NOT MODIFY BY HAND\n",
    },
    ignored: { ".dart_tool/package_config.json": "{}" },
    tools: { flutter: "Flutter 3.19.0 • channel stable", fvm: "3.1.0" },
    expect: {
      open: [
        "generated:build_runner:.",
        "toolchain:pin:flutter:.fvmrc",
        "worktree-env:setup:.:pub",
      ],
      commands: {
        "generated:build_runner:.": [
          "dart run build_runner build --delete-conflicting-outputs",
        ],
        "toolchain:pin:flutter:.fvmrc": ["fvm install 3.22.0"],
        "worktree-env:setup:.:pub": ["flutter pub get"],
      },
      forbidLinks: [".dart_tool"],
    },
  },
  // ── Toolchains ────────────────────────────────────────────────────────────
  {
    name: "pinned Node missing, with a version manager",
    tracked: {
      ".gitignore": "node_modules/\n",
      ".nvmrc": "20\n",
      "package.json": pkg({ name: "x" }),
      "package-lock.json": "{}",
    },
    tools: { node: null, npm: null, fnm: "fnm 1.37.0" },
    expect: {
      open: ["toolchain:npm"],
      fixKinds: { "toolchain:npm": "run-command" },
      commands: { "toolchain:npm": ["fnm install 20"] },
    },
  },
  {
    name: "pinned Node missing, no version manager",
    tracked: {
      ".gitignore": "node_modules/\n",
      ".nvmrc": "20\n",
      "package.json": pkg({ name: "x" }),
      "package-lock.json": "{}",
    },
    tools: { node: null, npm: null },
    expect: {
      open: ["toolchain:npm"],
      fixKinds: { "toolchain:npm": "manual" },
    },
  },
  {
    name: "an ecosystem without a recipe",
    tracked: {
      ".gitignore": "_build/\ndeps/\n",
      "mix.exs": "defmodule App.MixProject do\nend\n",
      "mix.lock": "%{}\n",
    },
    expect: {
      open: ["toolchain:unsupported:mix.exs"],
      confidence: { "toolchain:unsupported:mix.exs": "guess" },
    },
  },
]
