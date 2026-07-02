import type { Tool } from "./types"
import { toolError } from "./output"
import {
  listTodos,
  replaceTodos,
  mergeTodos,
  type TodoInput,
} from "../../db/repositories/todos"
import type { Todo } from "../../db/types"

// The agent's task list for the current conversation. A single tool that reads
// (no args) or writes (`todos` array, replace-all by default, optional merge).
// State persists in the `todos` table and is re-injected into the prompt each
// turn by runChat, so a multi-step plan survives context compression. Not a
// dangerous action — it touches only its own table, so it does NOT route through
// the approval gate.
export const todoWriteTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "Manage your task list for the current conversation. Use it for any task with 3+ " +
        "steps, or when the user gives you several things to do, so your plan survives " +
        "across tool calls and context compression.\n\n" +
        "Reading: call with no arguments to get the current list.\n\n" +
        "Writing: provide `todos` (an array of items). By default this REPLACES the whole " +
        "list — send the full plan each time. Set `merge: true` to instead update existing " +
        "items by id and append any new ones.\n\n" +
        "Each item is { id, content, status } where status is one of pending, in_progress, " +
        "completed, cancelled. List order is priority. Keep only ONE item in_progress at a " +
        "time. Mark an item completed as soon as it's done — never re-do completed work. If " +
        "something fails, mark it cancelled and add a revised item. To remove an item, omit " +
        "it from a replace-all write; send `todos: []` to clear the list.\n\n" +
        "Every call returns the full current list plus a summary count by status.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description:
              "Task items to write. Omit entirely to read the current list.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Unique item id within this conversation.",
                },
                content: {
                  type: "string",
                  description: "Short task description.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                  description: "Current status.",
                },
              },
              required: ["id", "content", "status"],
            },
          },
          merge: {
            type: "boolean",
            description:
              "true: update existing items by id and append new ones. " +
              "false (default): replace the entire list.",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args, ctx) => {
    const conversationId = ctx.conversationId
    if (!conversationId) {
      return toolError(
        "no_conversation",
        "The task list needs a conversation, which isn't available here."
      )
    }

    let { todos } = args as { todos?: unknown }
    const merge = args.merge === true

    // LLMs sometimes send `todos` as a JSON string rather than an array; parse it.
    if (typeof todos === "string") {
      try {
        todos = JSON.parse(todos)
      } catch {
        return toolError(
          "bad_args",
          "`todos` must be an array of items, not an unparseable string."
        )
      }
    }

    let items: Todo[]
    if (todos === undefined || todos === null) {
      items = listTodos(conversationId) // read
    } else if (!Array.isArray(todos)) {
      return toolError("bad_args", "`todos` must be an array of items.")
    } else {
      items = merge
        ? mergeTodos(conversationId, todos as TodoInput[])
        : replaceTodos(conversationId, todos as TodoInput[])
    }

    return JSON.stringify({
      todos: summarizeForModel(items),
      summary: countByStatus(items),
    })
  },
}

// Trim the rows to the fields the model cares about (drop timestamps/seq noise).
function summarizeForModel(items: Todo[]) {
  return items.map((t) => ({
    id: t.itemId,
    content: t.content,
    status: t.status,
  }))
}

function countByStatus(items: Todo[]) {
  return {
    total: items.length,
    pending: items.filter((t) => t.status === "pending").length,
    in_progress: items.filter((t) => t.status === "in_progress").length,
    completed: items.filter((t) => t.status === "completed").length,
    cancelled: items.filter((t) => t.status === "cancelled").length,
  }
}
