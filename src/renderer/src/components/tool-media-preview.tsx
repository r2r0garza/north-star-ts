import { useEffect, useState } from "react"
import type { ToolMediaReference } from "../../../shared/tool-media"
import { Button } from "@/components/ui/button"

const MAX_PREVIEWS = 16
const MAX_DATA_URL_LENGTH = 16 * 1024 * 1024

export function ToolMediaPreview({
  media,
  conversationId,
  messageId,
}: {
  media: ToolMediaReference[]
  conversationId?: string
  messageId?: string
}) {
  const [index, setIndex] = useState(0)
  const images = media.slice(0, MAX_PREVIEWS).sort((a, b) => a.order - b.order)
  const image = images[Math.min(index, images.length - 1)]
  if (!image) return null
  return (
    <section aria-label="Stored tool images" className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={index === 0}
          onClick={() => setIndex((value) => Math.max(0, value - 1))}
        >
          Previous image
        </Button>
        <span>
          Image {Math.min(index + 1, images.length)} of {images.length}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={index >= images.length - 1}
          onClick={() =>
            setIndex((value) => Math.min(images.length - 1, value + 1))
          }
        >
          Next image
        </Button>
      </div>
      {media.length > MAX_PREVIEWS && (
        <p>Only the first {MAX_PREVIEWS} images are previewed.</p>
      )}
      <StoredImage
        key={`${conversationId}:${messageId}:${image.id}`}
        image={image}
        conversationId={conversationId}
        messageId={messageId}
      />
    </section>
  )
}

function StoredImage({
  image,
  conversationId,
  messageId,
}: {
  image: ToolMediaReference
  conversationId?: string
  messageId?: string
}) {
  const [state, setState] = useState<{ dataUrl?: string; error?: string }>({})
  useEffect(() => {
    let active = true
    if (!conversationId || !messageId) {
      setState({ error: "Image unavailable: no stored result reference." })
      return
    }
    void window.cowork.db.messages
      .readMedia(conversationId, messageId, image.id)
      .then((result) => {
        if (!active) return
        const dataUrl = result.dataUrl
        if (
          result.error ||
          !dataUrl ||
          dataUrl.length > MAX_DATA_URL_LENGTH ||
          !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)
        ) {
          setState({
            error: "Image unavailable: it may have expired or been removed.",
          })
        } else {
          setState({ dataUrl })
        }
      })
      .catch(
        () =>
          active &&
          setState({
            error: "Image unavailable: could not load stored pixels.",
          })
      )
    return () => {
      active = false
    }
  }, [conversationId, messageId, image.id])

  return (
    <figure className="space-y-1">
      <figcaption className="text-xs break-words text-muted-foreground">
        {image.toolName} · image {image.order + 1} · {image.width} ×{" "}
        {image.height}
        {image.alt ? ` · ${image.alt}` : ""}
      </figcaption>
      {state.error ? (
        <p role="status">{state.error}</p>
      ) : state.dataUrl ? (
        <img
          src={state.dataUrl}
          alt={image.alt || `${image.toolName} image ${image.order + 1}`}
          className="max-h-96 max-w-full rounded border object-contain"
          decoding="async"
          onError={() =>
            setState({
              error: "Image unavailable: stored pixels could not be decoded.",
            })
          }
        />
      ) : (
        <p role="status" aria-live="polite">
          Loading stored image…
        </p>
      )}
    </figure>
  )
}
