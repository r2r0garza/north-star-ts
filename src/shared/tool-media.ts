export interface ToolMediaReference {
  version: 1
  id: string
  mediaType: "image/jpeg"
  width: number
  height: number
  byteLength: number
  sha256: string
  order: number
  alt: string
  createdAt: number
  expiresAt: number
  toolCallId: string
  toolName: string
}
