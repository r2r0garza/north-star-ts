export const RIG_KEY_MAX_LENGTH = 32
export const RESERVED_POD_KEYS = new Set(["rig", "system"])

const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SeatAddress {
  seatKey: string
  podKey: string
}

export function isRigKey(value: string): boolean {
  return value.length <= RIG_KEY_MAX_LENGTH && KEY_PATTERN.test(value)
}

export function isPodKey(value: string): boolean {
  return isRigKey(value) && !RESERVED_POD_KEYS.has(value)
}

export function formatSeatAddress(seatKey: string, podKey: string): string {
  if (!isRigKey(seatKey) || !isPodKey(podKey)) {
    throw new Error("Seat addresses require valid, non-reserved seat and pod keys")
  }
  return `${seatKey}@${podKey}`
}

export function parseSeatAddress(value: string): SeatAddress | null {
  const parts = value.split("@")
  if (parts.length !== 2) return null
  const [seatKey, podKey] = parts
  return isRigKey(seatKey) && isPodKey(podKey) ? { seatKey, podKey } : null
}

export function isReservedRigAddress(value: string): boolean {
  return value === "user@rig" || value === "navigator@rig"
}
