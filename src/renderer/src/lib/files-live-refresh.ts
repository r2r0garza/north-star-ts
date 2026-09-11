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
  return [
    ...new Set(
      paths
        .flatMap((path) => [parentDirectory(path), path])
        .filter((path) => cached.has(path))
    ),
  ]
}

export function pathAffectsSelection(
  path: string,
  selectedPath: string
): boolean {
  return selectedPath === path || selectedPath.startsWith(`${path}/`)
}
