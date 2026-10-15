export interface BashBlockRequest {
  messageId: string
  offset: number
}

export async function bashBlockCommand(
  content: string,
  offset: number
): Promise<string> {
  const [{ default: Markdown }, { default: remarkGfm }] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
  ])
  let command: string | undefined
  // Use the renderer's parser so nested fences and source positions agree.
  Markdown({
    children: content,
    remarkPlugins: [
      remarkGfm,
      () => (tree: any) => {
        const visit = (node: any) => {
          if (
            node.type === "code" &&
            node.lang === "bash" &&
            node.position?.start.offset === offset &&
            node.value.trim()
          ) {
            command = `${node.value}\n`
          }
          node.children?.forEach(visit)
        }
        visit(tree)
      },
    ],
  })
  if (command === undefined)
    throw new Error("This Bash block is no longer available.")
  return command
}
