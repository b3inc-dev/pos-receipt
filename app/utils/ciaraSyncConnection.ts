export type SyncConnectionState = "disabled" | "off" | "starting" | "failed" | "connected" | "pending";

export function syncConnectionState(enabled: boolean, hasSecret: boolean, schedulerState: "off" | "starting" | "failed" | "running", lastOk: boolean): SyncConnectionState {
  if (!enabled) return "disabled";
  if (!hasSecret || schedulerState === "off") return "off";
  if (schedulerState === "starting" || schedulerState === "failed") return schedulerState;
  return lastOk ? "connected" : "pending";
}
