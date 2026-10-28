import { createHash } from "node:crypto";

export type RegionId = string;

export function deterministicNetworkId(
  namespace: string,
  material: string,
): string {
  if (!namespace || !material) throw new Error("NETWORK_ID_INPUT_REQUIRED");
  return `${namespace}_${createHash("sha256")
    .update(namespace, "utf8")
    .update("\u0000", "utf8")
    .update(material, "utf8")
    .digest("hex")}`;
}

export interface ReplicatedAuthorityState {
  readonly authorityId: string;
  readonly version: number;
  readonly status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";
  readonly changedAt: string;
  readonly sourceRegion: RegionId;
}

const terminalRank: Readonly<
  Record<ReplicatedAuthorityState["status"], number>
> = {
  ACTIVE: 0,
  SUSPENDED: 1,
  EXPIRED: 2,
  REVOKED: 3,
};

/** Revocation/suspension safety wins over availability on equal version. */
export function resolveAuthorityReplicaConflict(
  left: ReplicatedAuthorityState,
  right: ReplicatedAuthorityState,
): ReplicatedAuthorityState {
  if (left.authorityId !== right.authorityId)
    throw new Error("AUTHORITY_CONFLICT_ID_MISMATCH");
  if (left.version !== right.version)
    return left.version > right.version ? left : right;
  if (terminalRank[left.status] !== terminalRank[right.status]) {
    return terminalRank[left.status] > terminalRank[right.status]
      ? left
      : right;
  }
  const leftTime = Date.parse(left.changedAt);
  const rightTime = Date.parse(right.changedAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return left.sourceRegion.localeCompare(right.sourceRegion) <= 0
    ? left
    : right;
}

export interface ReservationOwnership {
  readonly reservationId: string;
  readonly authorityId: string;
  readonly ownerRegion: RegionId;
  readonly epoch: number;
  readonly leaseExpiresAt: string;
}

export function mayAssumeReservationOwnership(
  current: ReservationOwnership,
  candidateRegion: RegionId,
  candidateEpoch: number,
  now: string,
): boolean {
  if (candidateEpoch <= current.epoch) return false;
  return (
    Date.parse(now) >= Date.parse(current.leaseExpiresAt) &&
    candidateRegion.length > 0
  );
}
