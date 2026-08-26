# Container oversized-line reads are not memory bounded

> Status: **CLOSED**  
> Severity: **P2 — resource exhaustion risk**  
> Area: container pageable file reads

## Problem

The container `readTextLines` Python helper iterates with `for raw in f`. Python
binary file iteration reads through the next newline before yielding `raw`.
Consequently, a very large or newline-free line is fully allocated and decoded
before the helper compares its size with `maxBytes` and returns a bounded prefix.

The response payload is bounded, but the work required to produce it is not.
This violates the pageable-read design requirement that a pathological line
must never be buffered in full. The Local reader already processes fixed-size
stream chunks.

## Impact

- A generated/minified file with a huge line can exhaust container memory.
- The container read process can be killed before returning the advertised
  `lineTooLong` result.
- Local and container backends have materially different safety properties.

## Reproduction test

Add a container integration test using a newline-free file substantially larger
than the configured response cap:

1. Constrain the container's memory or instrument the helper's maximum buffered
   bytes.
2. Read the first line with a small `maxBytes`.
3. Assert a bounded UTF-8-safe prefix and the explicit skip contract metadata.
4. Assert internal buffering stays within a documented constant multiple of the
   configured chunk/cap size.
5. Verify the following line remains reachable for an oversized line that does
   eventually end with a newline.

## Fix direction

- Replace line iteration with fixed-size binary chunk reads and an incremental
  newline splitter.
- Bound the pending requested-line prefix and discard its remainder incrementally
  until the newline required by the skip contract.
- Use an incremental UTF-8 decoder so characters spanning chunks remain valid.
- Preserve binary sniffing, offset/limit behavior, revision rules, and response
  metadata parity with `readHostTextLines`.

## Acceptance criteria

- No input line is buffered in full merely to enforce `maxBytes`.
- Memory use is bounded independently of line length.
- Oversized lines return the documented advancing skip contract.
- UTF-8 spanning chunk boundaries remains intact.
- Local, container, and attachment contract tests agree on output metadata.

## Resolution

- Replaced container helper line iteration with fixed-size binary chunk reads.
- Added bounded prefix accumulation for the first oversized returned line.
- Kept consuming an oversized returned line until its newline before reporting
  `nextOffset`, so the following line remains reachable.
- Added a container integration regression using a 2 MiB physical line followed
  by a second line.
