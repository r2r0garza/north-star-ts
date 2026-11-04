import { app, BrowserWindow, ipcMain, session } from "electron"
import { join } from "node:path"
import assert from "node:assert/strict"
import { createConversation } from "../../src/main/db/repositories/conversations"
import { appendMessage } from "../../src/main/db/repositories/messages"
import {
  recordToolCallIntents,
  markToolCallStarted,
  markToolCallSettled,
} from "../../src/main/db/repositories/tool-call-lifecycle"
import {
  readConversationArtifact,
  toolArtifactReference,
} from "../../src/main/db/repositories/conversation-artifacts"
import { closeDb } from "../../src/main/db/connection"
import { presentVisualTool } from "../../src/main/agent/tools/present_visual"
import { comparisonChart } from "../../src/shared/openui-comparison.fixture"
import type { ArtifactPresentation } from "../../src/shared/conversation-artifacts"

app.whenReady().then(async () => {
  process.env.NORTH_STAR_OPENUI_SPIKE = "1"
  const conversationId = createConversation({ mode: "chat" }).id
  const input = {
    title: "Durable synthetic answer",
    library: "north-star-static-v1",
    source: "Synthetic qualification data",
    document:
      'root = Stack([Text("Saved evidence survives reload"),Metric("Completion",0.75,"percent"),Chart("rates")]);',
    datasets: [{ id: "rates", snapshot: comparisonChart }],
  }
  const call = {
    id: "visual-check",
    name: "present_visual",
    arguments: JSON.stringify(input),
  }
  const assistant = appendMessage({
    conversationId,
    role: "assistant",
    content: null,
    toolCalls: [call],
  })
  recordToolCallIntents({
    conversationId,
    assistantMessageId: assistant.id,
    logicalRoundId: "visual-check",
    calls: [call],
  })
  const owner = markToolCallStarted({ conversationId, toolCallId: call.id })!
  let artifact: ArtifactPresentation | undefined
  await presentVisualTool.execute(input, {
    workspace: "",
    conversationId,
    invocationId: owner.invocationId,
    emitArtifact: (value) => {
      artifact = value
    },
  })
  assert.ok(artifact)
  const settled = markToolCallSettled({
    conversationId,
    toolCallId: call.id,
    state: "settled_success",
    presentationArtifact: artifact,
  })!
  appendMessage({
    conversationId,
    role: "tool",
    content: settled.result,
    toolCallId: call.id,
    toolName: call.name,
  })
  const reference = toolArtifactReference(conversationId, call.id)!
  assert.ok(reference)
  closeDb()
  assert.equal(
    readConversationArtifact(conversationId, reference.artifactId, 1).artifact
      ?.snapshot.kind,
    "visual"
  )
  ipcMain.handle("fixture:reference", () => ({ conversationId, reference }))
  ipcMain.handle("fixture:read", (_event, cid, id, revision) =>
    cid === conversationId && id === reference.artifactId
      ? readConversationArtifact(cid, id, revision)
      : { error: "Not owned" }
  )
  session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith("file://") })
  )
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )
  const window = new BrowserWindow({
    width: 780,
    height: 900,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  await window.loadFile(join(__dirname, "renderer/openui-durable.html"))
})
app.on("window-all-closed", () => {
  closeDb()
  app.quit()
})
