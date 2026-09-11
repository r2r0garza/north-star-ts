export function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/")
  return separator === -1 ? "" : path.slice(0, separator)
}

export function affectedCachedDirectories(
  paths: string[],
  cachedDirectories: string[],
  overflow = false
): string[] {
  if (overflow) return cachedDirectories
  const cached = new Set(cachedDirectories)
  const affected = paths.flatMap((path) => [parentDirectory(path), path])
  for (const path of paths) {
    if (path.split("/").pop() !== ".gitignore") continue
    const directory = parentDirectory(path)
    affected.push(
      ...cachedDirectories.filter(
        (cachedPath) =>
          directory === "" ||
          cachedPath === directory ||
          cachedPath.startsWith(`${directory}/`)
      )
    )
  }
  return [...new Set(affected.filter((path) => cached.has(path)))]
}

export function pathAffectsSelection(
  path: string,
  selectedPath: string
): boolean {
  return selectedPath === path || selectedPath.startsWith(`${path}/`)
}
