import { Fragment } from "react"
import { splitConversationFindText } from "@/lib/conversation-find"

export function ConversationFindText({
  text,
  query,
}: {
  text: string
  query: string
}) {
  return splitConversationFindText(text, query).map((segment, index) =>
    segment.match ? (
      <mark
        key={index}
        data-conversation-find-match
        className="rounded-sm bg-yellow-200 text-inherit dark:bg-yellow-700"
      >
        {segment.text}
      </mark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    )
  )
}
