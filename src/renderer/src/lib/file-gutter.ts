export type FileGutterAnnotation = {
  change?: "added" | "modified"
  deletedBefore?: number
  deletedAfter?: number
}

export type FileGutterAnnotations = Record<number, FileGutterAnnotation>

type ChangeRun = {
  addedLines: number[]
  removedCount: number
  anchorLine: number
}

export function buildFileGutterAnnotations(
  diff: string,
  lineCount: number
): FileGutterAnnotations {
  const annotations: FileGutterAnnotations = {}
  let newLine = 0
  let inHunk = false
  let run: ChangeRun | null = null

  const annotationAt = (line: number): FileGutterAnnotation =>
    (annotations[line] ??= {})

  const flushRun = () => {
    if (!run) return
    const modifiedCount = Math.min(run.removedCount, run.addedLines.length)
    run.addedLines.forEach((line, index) => {
      annotationAt(line).change = index < modifiedCount ? "modified" : "added"
    })

    const deletedCount = run.removedCount - modifiedCount
    if (deletedCount > 0 && lineCount > 0) {
      if (run.anchorLine > lineCount) {
        annotationAt(lineCount).deletedAfter =
          (annotationAt(lineCount).deletedAfter ?? 0) + deletedCount
      } else {
        const line = Math.max(1, run.anchorLine)
        annotationAt(line).deletedBefore =
          (annotationAt(line).deletedBefore ?? 0) + deletedCount
      }
    }
    run = null
  }

  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      flushRun()
      newLine = Number(hunk[2])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith("\\")) continue
    if (line.startsWith("-")) {
      run ??= { addedLines: [], removedCount: 0, anchorLine: newLine }
      run.removedCount += 1
      continue
    }
    if (line.startsWith("+")) {
      run ??= { addedLines: [], removedCount: 0, anchorLine: newLine }
      run.addedLines.push(newLine)
      newLine += 1
      continue
    }
    flushRun()
    newLine += 1
  }
  flushRun()

  return annotations
}
