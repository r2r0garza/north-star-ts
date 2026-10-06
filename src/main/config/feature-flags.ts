export function missionControlEnabled(): boolean {
  return process.env.NEXT_mission_control?.trim().toLowerCase() === "true"
}
