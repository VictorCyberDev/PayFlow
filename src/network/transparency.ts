import { createHash } from "node:crypto";

export interface TransparencyEntry {
  readonly sequence: number;
  readonly issuer: string;
  readonly keyId: string;
  readonly status: "ACTIVE" | "ROTATING" | "REVOKED";
  readonly publicKeyDigest: string;
  readonly recordedAt: string;
  readonly previousHash: string | null;
  readonly entryHash: string;
}

function computeEntryHash(input: Omit<TransparencyEntry, "entryHash">): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

export function appendTransparencyEntry(
  previous: TransparencyEntry | null,
  input: Omit<TransparencyEntry, "sequence" | "previousHash" | "entryHash">,
): TransparencyEntry {
  const unsigned = {
    sequence: (previous?.sequence ?? 0) + 1,
    ...input,
    previousHash: previous?.entryHash ?? null,
  };
  return { ...unsigned, entryHash: computeEntryHash(unsigned) };
}

export function verifyTransparencyLog(entries: readonly TransparencyEntry[]): boolean {
  let previous: TransparencyEntry | null = null;
  for (const entry of entries) {
    const { entryHash, ...unsigned } = entry;
    if (entry.sequence !== (previous?.sequence ?? 0) + 1) return false;
    if (entry.previousHash !== (previous?.entryHash ?? null)) return false;
    if (computeEntryHash(unsigned) !== entryHash) return false;
    previous = entry;
  }
  return true;
}
