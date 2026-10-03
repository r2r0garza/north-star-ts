// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Workspace } from "@/types"
import { AppLaunchEditor } from "./app-launch-editor"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

let container: HTMLDivElement
let root: Root
let update: ReturnType<typeof vi.fn>

const workspace = (services: Workspace["appLaunch"]["services"] = []) =>
  ({
    id: "w1",
    path: "/repo",
    name: "repo",
    generatedFiles: [],
    worktreeSetup: { linkPaths: [], steps: [] },
    appLaunch: { services },
    missionControl: { checksDir: "e2e" },
    createdAt: 0,
    updatedAt: 0,
  }) as Workspace

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  update = vi.fn(async (_id: string, patch: Partial<Workspace>) => ({
    ...workspace(),
    ...patch,
  }))
  ;(window as unknown as { cowork: unknown }).cowork = {
    db: { workspaces: { update } },
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function type(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`
  )!
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function button(text: string) {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text
  )!
}

describe("AppLaunchEditor", () => {
  it("adds a service and saves the normalized recipe", async () => {
    act(() =>
      root.render(
        <AppLaunchEditor workspace={workspace()} onSaved={() => {}} />
      )
    )
    act(() => button("Add service").click())
    type("Service 1 label", "Web app")
    type("Service 1 command", "pnpm dev --port {port}")
    type("Service 1 directory", "./web/")
    await act(async () => button("Save").click())
    expect(update).toHaveBeenCalledWith("w1", {
      appLaunch: {
        services: [
          {
            key: "web-app",
            label: "Web app",
            command: "pnpm dev --port {port}",
            cwd: "web",
            port: "auto",
            ready: { http: "/" },
            source: "user",
          },
        ],
      },
    })
  })

  it("shows what's wrong and won't save an invalid recipe", () => {
    act(() =>
      root.render(
        <AppLaunchEditor
          workspace={workspace([
            {
              key: "web",
              label: "Web",
              command: "vite",
              cwd: "",
              port: "auto",
              ready: { http: "/" },
              source: "analysis",
              findingKey: "app-launch:recipe",
            },
          ])}
          onSaved={() => {}}
        />
      )
    )
    expect(container.textContent).toContain("Suggested")
    expect(container.textContent).not.toContain("Save")
    type("Service 1 environment", "API=http://localhost:{port:api}")
    expect(container.textContent).toContain(`there's no service "api"`)
    expect(button("Save").disabled).toBe(true)
  })
})
