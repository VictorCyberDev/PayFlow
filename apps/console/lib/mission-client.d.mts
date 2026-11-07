export class MissionApiError extends Error {
  kind: "AUTH" | "NOT_FOUND" | "UNAVAILABLE" | "INVALID";
}
export function normalizeOrigin(input: unknown): string | null;
export function money(minor: number, currency: string): string;
type Json = any;
export function createMissionClient(o: {
  origin?: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): {
  list(): Promise<{ missions: Json[]; next: string | null }>;
  mission(id: string): Promise<Json>;
  history(id: string): Promise<{ versions: Json[]; transitions: Json[] }>;
  plan(id: string): Promise<Json>;
  ledger(id: string): Promise<Json>;
  authorities(id: string): Promise<Json>;
};
