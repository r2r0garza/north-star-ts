const LEADING_SKILL_COMMAND = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/

export function forcedSkillNames(
  userMessage: string | undefined,
  selectedSkillNames: string[] | undefined
): { names: string[]; modelMessage?: string } {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  for (const name of selectedSkillNames ?? []) add(name)

  if (userMessage !== undefined) {
    const command = LEADING_SKILL_COMMAND.exec(userMessage.trim())
    if (command) {
      add(command[1])
      return { names, modelMessage: command[2] ?? "" }
    }
  }
  return { names }
}
