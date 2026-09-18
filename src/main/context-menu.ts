import {
  BrowserWindow,
  Menu,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron"

function editItem(
  role: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll",
  enabled: boolean
): MenuItemConstructorOptions {
  return { role, enabled }
}

export function textContextMenuTemplate(
  webContents: WebContents,
  params: ContextMenuParams
): MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    return params.selectionText.trim() ? [{ role: "copy" }] : []
  }

  const template: MenuItemConstructorOptions[] = []
  const suggestions = params.misspelledWord ? params.dictionarySuggestions : []

  for (const suggestion of suggestions) {
    template.push({
      label: suggestion,
      click: () => webContents.replaceMisspelling(suggestion),
    })
  }

  if (params.misspelledWord) {
    if (suggestions.length > 0) template.push({ type: "separator" })
    template.push({
      label: "Add to Dictionary",
      click: () =>
        webContents.session.addWordToSpellCheckerDictionary(
          params.misspelledWord
        ),
    })
    template.push({ type: "separator" })
  }

  template.push(
    editItem("undo", params.editFlags.canUndo),
    editItem("redo", params.editFlags.canRedo),
    { type: "separator" },
    editItem("cut", params.editFlags.canCut),
    editItem("copy", params.editFlags.canCopy),
    editItem("paste", params.editFlags.canPaste),
    { type: "separator" },
    editItem("selectAll", params.editFlags.canSelectAll)
  )

  return template
}

export function registerTextContextMenu(webContents: WebContents): () => void {
  const onContextMenu = (_event: Electron.Event, params: ContextMenuParams) => {
    const template = textContextMenuTemplate(webContents, params)
    if (template.length === 0) return

    const menu = Menu.buildFromTemplate(template)
    const window = BrowserWindow.fromWebContents(webContents)
    menu.popup({
      ...(window ? { window } : {}),
      ...(params.frame ? { frame: params.frame } : {}),
      x: params.x,
      y: params.y,
      sourceType: params.menuSourceType,
    })
  }

  webContents.on("context-menu", onContextMenu)
  return () => webContents.removeListener("context-menu", onContextMenu)
}
