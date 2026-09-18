import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ContextMenuParams,
  EditFlags,
  MenuItemConstructorOptions,
  WebContents,
} from "electron"

const mocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
  fromWebContents: vi.fn(),
}))

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
}))

import {
  registerTextContextMenu,
  textContextMenuTemplate,
} from "./context-menu"

const editFlags: EditFlags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: false,
}

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    isEditable: false,
    selectionText: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    editFlags,
    x: 12,
    y: 24,
    frame: null,
    menuSourceType: "mouse",
    ...overrides,
  } as ContextMenuParams
}

class FakeWebContents extends EventEmitter {
  replaceMisspelling = vi.fn()
  session = {
    addWordToSpellCheckerDictionary: vi.fn(() => true),
  }
}

function roles(template: MenuItemConstructorOptions[]) {
  return template.map((item) => item.role ?? item.type ?? item.label)
}

beforeEach(() => {
  mocks.buildFromTemplate.mockReset().mockReturnValue({ popup: mocks.popup })
  mocks.popup.mockReset()
  mocks.fromWebContents.mockReset().mockReturnValue(null)
})

describe("textContextMenuTemplate", () => {
  it("builds the full edit menu and applies renderer edit flags", () => {
    const webContents = new FakeWebContents() as unknown as WebContents
    const template = textContextMenuTemplate(
      webContents,
      params({
        isEditable: true,
        editFlags: {
          ...editFlags,
          canUndo: true,
          canCut: true,
          canCopy: true,
          canPaste: true,
        },
      })
    )

    expect(roles(template)).toEqual([
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "separator",
      "selectAll",
    ])
    expect(template.map((item) => item.enabled)).toEqual([
      true,
      false,
      undefined,
      true,
      true,
      true,
      undefined,
      true,
    ])
  })

  it("offers spelling suggestions and Add to Dictionary before edit actions", () => {
    const contents = new FakeWebContents()
    const template = textContextMenuTemplate(
      contents as unknown as WebContents,
      params({
        isEditable: true,
        misspelledWord: "teh",
        dictionarySuggestions: ["the", "tech"],
      })
    )

    expect(roles(template).slice(0, 5)).toEqual([
      "the",
      "tech",
      "separator",
      "Add to Dictionary",
      "separator",
    ])

    template[0].click?.({} as never, {} as never, {} as never)
    template[3].click?.({} as never, {} as never, {} as never)

    expect(contents.replaceMisspelling).toHaveBeenCalledWith("the")
    expect(
      contents.session.addWordToSpellCheckerDictionary
    ).toHaveBeenCalledWith("teh")
  })

  it("offers only Copy for selected read-only message text", () => {
    const webContents = new FakeWebContents() as unknown as WebContents

    expect(
      textContextMenuTemplate(webContents, params({ selectionText: "message" }))
    ).toEqual([{ role: "copy" }])
    expect(
      textContextMenuTemplate(webContents, params({ selectionText: "   " }))
    ).toEqual([])
  })
})

describe("registerTextContextMenu", () => {
  it("opens the native menu for the originating WebContents", () => {
    const contents = new FakeWebContents()
    const webContents = contents as unknown as WebContents
    const window = { id: 1 }
    const frame = { name: "main" }
    mocks.fromWebContents.mockReturnValue(window)

    const unregister = registerTextContextMenu(webContents)
    contents.emit(
      "context-menu",
      {},
      params({ selectionText: "message", frame: frame as never })
    )

    expect(mocks.buildFromTemplate).toHaveBeenCalledWith([{ role: "copy" }])
    expect(mocks.fromWebContents).toHaveBeenCalledWith(webContents)
    expect(mocks.popup).toHaveBeenCalledWith({
      window,
      frame,
      x: 12,
      y: 24,
      sourceType: "mouse",
    })

    unregister()
    expect(contents.listenerCount("context-menu")).toBe(0)
  })

  it("does not replace custom menus without editable or selected text", () => {
    const contents = new FakeWebContents()
    registerTextContextMenu(contents as unknown as WebContents)

    contents.emit("context-menu", {}, params())

    expect(mocks.buildFromTemplate).not.toHaveBeenCalled()
    expect(mocks.popup).not.toHaveBeenCalled()
  })
})
