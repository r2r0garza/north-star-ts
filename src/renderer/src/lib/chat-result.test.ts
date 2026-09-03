import { describe, expect, it } from "vitest"
import {
  chatResultNotification,
  isUnexpectedEmptyChatSuccess,
} from "./chat-result"

const snippet = (text: string) => text

describe("chat result classification", () => {
  it.each([{ content: undefined }, { content: "" }, { content: "   \n\t" }])(
    "routes unexpected empty success to an error notification",
    (result) => {
      expect(isUnexpectedEmptyChatSuccess(result)).toBe(true)
      expect(chatResultNotification(result, snippet)).toEqual({
        kind: "turnError",
        body: "The model returned no usable answer.",
      })
    }
  )

  it("routes normal success to completion", () => {
    expect(chatResultNotification({ content: "Finished." }, snippet)).toEqual({
      kind: "turnComplete",
      body: "The agent finished its turn.",
    })
  })

  it("stays silent on cancellation", () => {
    expect(chatResultNotification({ stopped: true }, snippet)).toBeNull()
  })

  it("keeps explicit errors as error notifications", () => {
    expect(chatResultNotification({ error: "failed" }, snippet)).toEqual({
      kind: "turnError",
      body: "failed",
    })
  })
})
