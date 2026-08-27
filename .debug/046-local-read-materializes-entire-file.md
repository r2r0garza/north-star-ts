# Local pageable reads materialize the entire file before enforcing limits

> Status: **CLOSED**
> Severity: **P2 — avoidable memory exhaustion and false read failures**
> Area: local filesystem read backend

## Problem

The local Python helper reads every file chunk, joins the complete byte array,
base64-encodes it, and sends it through subprocess capture. Node decodes the
entire file before applying the requested line offset, line limit, and output
byte cap. A small pageable read of a large file can allocate several copies of
the file or fail at the subprocess capture limit.

Container and attachment reads enforce pagination closer to the data source;
the local backend therefore has materially different resource behavior.

## Reproduction test

Create a sparse or generated file larger than the subprocess capture limit and
request a small range near its beginning and near its end. Assert bounded memory
and successful pagination without returning or buffering the complete file.
Cover oversized lines, binary detection, UTF-8 boundaries, and revision output.

## Fix direction

Move offset, line count, binary probing, and maximum returned bytes into the safe
filesystem helper. Stream chunks and stop once the requested page is complete.
If a full-file revision is required, compute it incrementally without retaining
the bytes and return it only after EOF was observed.

## Acceptance criteria

- Memory and IPC output are bounded by a documented small multiple of the page
  size, not the source-file size.
- Large local files support the same pagination semantics as other backends.
- Binary, line-too-long, UTF-8, truncation, and revision metadata remain correct.

## Resolution

- Moved `LocalEnvironment.readTextLines` into the safe filesystem helper as a
  chunked `read_text_lines` operation.
- Kept workspace confinement and `O_NOFOLLOW` path handling while enforcing
  offset, line limit, binary sniffing, and returned-byte caps in the helper.
- Computes SHA-256 revision incrementally and only returns it after EOF.
- Replaced the local large-file regression with a file whose old base64 helper
  path would exceed the subprocess capture cap while tiny paged reads succeed.

## Verification

- `npx vitest run src/main/agent/env/local.test.ts`
- `npm run typecheck`
