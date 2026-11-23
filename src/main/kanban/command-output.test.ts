import { expect, it } from "vitest"
import { spawn } from "node:child_process"
import { captureSpawn } from "../agent/env/spawn-util"
import { CommandOutputStore, COMMAND_OUTPUT_BYTES } from "./command-output"

it("retains incremental stdout/stderr before exit and catches up without duplicate output", async () => {
  const store = new CommandOutputStore()
  store.start("run", "test command", "/workspace")
  let attached = false
  const child = spawn(process.execPath, [
    "-e",
    `
    process.stdout.write('first\\n');
    setTimeout(() => process.stderr.write('second\\n'), 150);
    setTimeout(() => process.exit(7), 350);
  `,
  ])
  const result = await captureSpawn(child, {
    timeoutMs: 5000,
    maxOutputBytes: 3,
    onOutput: (chunk) => {
      store.append("run", chunk)
      if (store.get("run")!.output.includes("second")) {
        expect(child.exitCode).toBeNull()
        expect(store.get("run")!.output).toBe("first\nsecond\n")
        attached = true
      }
    },
  })
  expect(attached).toBe(true)
  store.finish("run", { status: "exited", exitCode: result.exitCode })
  expect(store.get("run")).toMatchObject({
    status: "exited",
    exitCode: 7,
    output: "first\nsecond\n",
  })
  expect(store.get("run")).toEqual(store.get("run"))
})

it("bounds output, preserves split UTF8, and isolates identical-command reruns", () => {
  const store = new CommandOutputStore()
  store.start("a", "same", "/a")
  store.start("b", "same", "/b")
  store.append("a", {
    stream: "stdout",
    data: Buffer.from("x".repeat(COMMAND_OUTPUT_BYTES + 20)),
  })
  const utf8 = Buffer.from("🙂")
  store.append("b", { stream: "stdout", data: utf8.subarray(0, 2) })
  store.append("b", { stream: "stdout", data: utf8.subarray(2) })
  expect(store.get("a")).toMatchObject({
    output: "x".repeat(COMMAND_OUTPUT_BYTES),
    omittedBytes: 20,
  })
  expect(store.get("b")!.output).toBe("🙂")
  const snapshot = store.get("a")!
  snapshot.output = "modified client snapshot"
  expect(store.get("a")!.output.length).toBe(COMMAND_OUTPUT_BYTES)
  store.finish("a", { status: "exited", exitCode: 0 })
  store.append("a", { stream: "stdout", data: Buffer.from("late") })
  expect(store.get("b")!.output).toBe("🙂")
  expect(store.get("a")!.output).not.toContain("late")
})

it("keeps final output on stop, timeout, startup failure, and no-output completion", () => {
  for (const status of ["stopped", "timed_out", "failed", "exited"] as const) {
    const store = new CommandOutputStore()
    store.start(status, "cmd", "/cwd", true)
    expect(store.get(status)!.status).toBe("queued")
    store.start(status, "cmd", "/cwd")
    store.running(status)
    expect(store.get(status)!.status).toBe("running")
    if (status === "stopped") {
      store.stop(status, "moved")
      store.append(status, {
        stream: "stderr",
        data: Buffer.from("final drain"),
      })
    }
    store.finish(status, { status, exitCode: status === "exited" ? 0 : null })
    expect(store.get(status)).toMatchObject({
      status,
      output: status === "stopped" ? "final drain" : "",
    })
  }
})

it("evicts old completed logs but not active runs", () => {
  const store = new CommandOutputStore()
  store.start("active", "cmd", "/cwd")
  for (let i = 0; i < 110; i++) {
    store.start(String(i), "cmd", "/cwd")
    store.finish(String(i), { status: "exited", exitCode: 0 })
  }
  expect(store.get("active")).not.toBeNull()
  expect(store.get("0")).toBeNull()
  expect(store.get("109")).not.toBeNull()
})
