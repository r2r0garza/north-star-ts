import type { Tool, ToolContext } from "../types"
import { toolError } from "../output"

// Hand the browser to the user for something only a human can do: a captcha, a
// login, a 2FA prompt, a cookie/consent wall, a paywall, an email verification
// link, etc. It reveals the browser window and PAUSES the turn (via ctx.ask)
// until the user says they're done — then the agent picks up from where it left
// off (call browser_snapshot to see the now-unblocked page).
//
// This is one tool, not one-per-obstacle (captcha/login/2FA/…): the mechanism is
// always the same — reveal, pause, wait for the human, resume — and a single
// tool with a `reason` covers every case without the model guessing which
// specific tool applies.
export const browserHandoffTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "browser_handoff",
      description:
        "Hand the browser to the user when you hit something only a human can do " +
        "— a CAPTCHA, a login/sign-in, a 2FA code, a cookie/consent wall, a " +
        "paywall, an email-verification link. It brings the browser window to the " +
        "front and PAUSES you until the user finishes and confirms. When they're " +
        "done, continue from where you stopped (call browser_snapshot to see the " +
        "unblocked page). Use this instead of guessing credentials or trying to " +
        "solve a CAPTCHA yourself.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "A short, specific explanation of what the user needs to do, e.g. " +
              '"Solve the CAPTCHA on the login page" or "Sign in to your GitHub ' +
              'account". Shown to the user.',
          },
        },
        required: ["reason"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : "Complete a step in the browser that requires a human"
    if (!ctx.browser) {
      return toolError("no_browser", "The agent browser is unavailable.")
    }
    if (!ctx.ask) {
      return toolError(
        "unavailable",
        "Handing off to the user isn't available in this context."
      )
    }

    // Bring the browser to the front — the user can't act on what they can't see
    // (and, once the visibility setting lands, it may have been hidden).
    ctx.browser.reveal()

    // Pause the turn until the user confirms. Reuses the same ask() gate as
    // ask_user_question: the turn blocks here until they answer (or cancel by
    // stopping the turn). A free-form "Other" field is always added by the UI.
    const result = await ctx.ask([
      {
        question: `The browser needs you: ${reason}. Do what's needed in the browser window, then choose an option below.`,
        header: "Browser handoff",
        options: [
          {
            label: "Done — continue",
            description: "I've finished; pick up from here.",
          },
          {
            label: "I couldn't complete it",
            description: "Stop trying to proceed past this step.",
          },
        ],
      },
    ])

    if (result.status === "cancelled") {
      return toolError(
        "cancelled",
        "The user dismissed the handoff without responding."
      )
    }

    const answer = result.answers[0]
    const selected = answer?.selected?.[0] ?? ""
    const note = answer?.other?.trim()
    if (selected.startsWith("I couldn't")) {
      return `The user could not complete the step${note ? `: ${note}` : "."} Do not keep trying to get past it; consider a different approach or ask how to proceed.`
    }
    return `The user completed the step${note ? ` (they noted: ${note})` : ""}. Continue from where you left off — call browser_snapshot to see the current page.`
  },
}
