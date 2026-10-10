import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "fs/promises"
import { arch, release, tmpdir } from "os"
import { join } from "path"
import { privateDirectories } from "./setup"
import {
  guardWindowsRegistry,
  windowsPrivatePaths,
  withWindowsProbeWorker,
} from "./windows-state"

// Opt-in latency harness: NS_MEASURE_WINDOWS_STARTUP=1 [NS_MEASURE_SAMPLES=n].
const samples = Number(process.env.NS_MEASURE_WINDOWS_STARTUP_SAMPLES || 10)
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    cold: values[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
    samples: values.length,
  }
}

describe.runIf(
  process.platform === "win32" && process.env.NS_MEASURE_WINDOWS_STARTUP === "1"
)("Windows subscription startup measurements", () => {
  it("reports one-shot and request-worker setup latency", async () => {
    const root = await mkdtemp(join(tmpdir(), "ns measure é '-"))
    const signal = new AbortController().signal
    const oneShot: number[] = []
    const generation: number[] = []
    const firstProbe: number[] = []
    try {
      for (let i = 0; i <= samples; i++) {
        const path = join(root, `one-shot-${i}`)
        const started = performance.now()
        await windowsPrivatePaths([{ path, create: true }], signal)
        oneShot.push(Math.round(performance.now() - started))
      }
      for (let i = 0; i <= samples; i++) {
        const appData = join(root, `request-${i}`)
        await windowsPrivatePaths([{ path: appData, create: true }], signal)
        const started = performance.now()
        await withWindowsProbeWorker(signal, async () => {
          const files = await privateDirectories(appData, signal)
          firstProbe.push(Math.round(performance.now() - started))
          await guardWindowsRegistry(process.env, signal)
          await guardWindowsRegistry(process.env, signal)
          await files.files(
            ["system.txt", "mcp.json", "settings.json", "manifest.json"].map(
              (name) => ({ name, value: "synthetic" })
            )
          )
          await files.close()
        })
        generation.push(Math.round(performance.now() - started))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    console.info("Windows startup measurements", {
      host: {
        os: release(),
        nodeArch: arch(),
        processorArch: process.env.PROCESSOR_ARCHITECTURE,
        wow64: process.env.PROCESSOR_ARCHITEW6432 ?? null,
      },
      oneShotProbeMs: summary(oneShot),
      workerFirstProbeMs: summary(firstProbe),
      generationSetupMs: summary(generation),
    })
    expect(generation).toHaveLength(samples + 1)
  }, 600000)
})
