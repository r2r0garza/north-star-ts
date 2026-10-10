const MAX_INPUT_BYTES = 16 * 1024 * 1024
const MAX_PIXELS = 24 * 1024 * 1024
const MAX_EDGE = 16384
const OUTPUT_EDGE = 1568
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 15000
const MAX_ACTIVE_DECODERS = 2
let activeDecoders = 0

export interface ImageInfo {
  format: "png" | "jpeg" | "gif" | "webp"
  width: number
  height: number
}

export interface DecodedImage {
  jpegBase64: string
  width: number
  height: number
}

// Inspect dimensions before Chromium allocates a decoded bitmap. The decoder
// still validates the complete file; a recognizable header is not a valid image.
export function inspectImage(data: Buffer): ImageInfo {
  if (data.length > MAX_INPUT_BYTES)
    throw new Error("Image exceeds the 16 MiB byte limit.")
  let info: ImageInfo | undefined
  if (
    data.length >= 24 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR"
  ) {
    info = {
      format: "png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    }
  } else if (
    data.length >= 10 &&
    /^GIF8[79]a$/.test(data.toString("ascii", 0, 6))
  ) {
    info = {
      format: "gif",
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8),
    }
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) break
      while (data[offset] === 0xff) offset++
      const marker = data[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > data.length) break
      const size = data.readUInt16BE(offset)
      if (size < 2 || offset + size > data.length) break
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        size >= 8
      ) {
        info = {
          format: "jpeg",
          width: data.readUInt16BE(offset + 5),
          height: data.readUInt16BE(offset + 3),
        }
        break
      }
      offset += size
    }
  } else if (
    data.length >= 30 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = data.toString("ascii", 12, 16)
    if (chunk === "VP8X")
      info = {
        format: "webp",
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      }
    if (
      chunk === "VP8 " &&
      data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    )
      info = {
        format: "webp",
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
      }
    if (chunk === "VP8L" && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21)
      info = {
        format: "webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      }
    }
  }
  if (!info)
    throw new Error(
      "Unsupported or malformed image header; expected JPEG, PNG, WebP or GIF."
    )
  if (
    !info.width ||
    !info.height ||
    Math.max(info.width, info.height) > MAX_EDGE ||
    info.width * info.height > MAX_PIXELS
  ) {
    throw new Error(
      "Image dimensions exceed the 24 megapixel / 16384 pixel edge limit or are invalid."
    )
  }
  return info
}

export async function decodeImage(
  data: Buffer,
  signal?: AbortSignal
): Promise<DecodedImage> {
  const info = inspectImage(data)
  if (signal?.aborted) throw new Error("Image decoding canceled.")
  const { BrowserWindow } = await import("electron")
  if (!BrowserWindow)
    throw new Error("Local image decoder is unavailable outside Electron.")
  if (signal?.aborted) throw new Error("Image decoding canceled.")
  // No filesystem APIs or preload. Only already-authorized bytes enter this
  // disposable renderer; destruction interrupts even a stuck native decode.
  if (activeDecoders >= MAX_ACTIVE_DECODERS)
    throw new Error(
      "Local image decoder capacity is unavailable; retry this read."
    )
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  })
  activeDecoders++
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event) => event.preventDefault())
  try {
    return await new Promise<DecodedImage>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, result?: DecodedImage) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        if (!window.isDestroyed()) window.destroy()
        if (error) reject(error)
        else resolve(result!)
      }
      const abort = () => finish(new Error("Image decoding canceled."))
      const timer = setTimeout(
        () => finish(new Error("Image decoding timed out.")),
        TIMEOUT_MS
      )
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      window.webContents.once("render-process-gone", () =>
        finish(new Error("Local image decoder exited."))
      )
      const html =
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src blob:; connect-src 'none'\">"
      void (async () => {
        await window.loadURL(`data:text/html,${encodeURIComponent(html)}`)
        if (settled) return
        const result = (await window.webContents
          .executeJavaScript(`(async () => {
          const bytes = Uint8Array.from(atob(${JSON.stringify(data.toString("base64"))}), c => c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/${info.format}'}), {imageOrientation: 'from-image'});
          try {
            if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > ${MAX_PIXELS} || Math.max(bitmap.width, bitmap.height) > ${MAX_EDGE}) throw new Error('Decoded image exceeds dimension limits.');
            const scale = Math.min(1, ${OUTPUT_EDGE} / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext('2d');
            context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            return {jpegBase64: canvas.toDataURL('image/jpeg', 0.8).split(',')[1], width: canvas.width, height: canvas.height};
          } finally { bitmap.close(); }
        })()`)) as DecodedImage
        if (
          !result ||
          !Number.isInteger(result.width) ||
          !Number.isInteger(result.height) ||
          result.width < 1 ||
          result.height < 1 ||
          Math.max(result.width, result.height) > OUTPUT_EDGE ||
          typeof result.jpegBase64 !== "string" ||
          result.jpegBase64.length > Math.ceil(MAX_OUTPUT_BYTES / 3) * 4
        )
          throw new Error("Invalid or oversized decoded image output.")
        const jpeg = Buffer.from(result.jpegBase64, "base64")
        if (
          jpeg.length > MAX_OUTPUT_BYTES ||
          jpeg[0] !== 0xff ||
          jpeg[1] !== 0xd8
        )
          throw new Error("Local decoder did not produce a bounded JPEG.")
        finish(undefined, result)
      })().catch((error) =>
        finish(error instanceof Error ? error : new Error(String(error)))
      )
    })
  } finally {
    activeDecoders--
    if (!window.isDestroyed()) window.destroy()
  }
}
