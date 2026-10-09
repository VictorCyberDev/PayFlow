import { createHash, randomUUID } from 'node:crypto';

type EvidenceType = 'MANDATE_CREATED'|'MANDATE_FINGERPRINTED'|'AGENT_AUTHORITY_VERIFIED'|'TRANSACTION_PROPOSED'|'POLICY_EVALUATED'|'AUTHORIZATION_ALLOWED'|'AUTHORIZATION_DENIED'|'AUTHORIZATION_ESCALATED'|'HUMAN_APPROVAL_GRANTED'|'PAYMENT_ORDER_CREATED'|'PAYMENT_CAPTURED'|'PAYMENT_FAILED'|'REFUND_REQUESTED'|'REFUND_COMPLETED';
export interface EvidenceEntry { readonly id: string; readonly sequence: number; readonly type: EvidenceType; readonly occurredAt: string; readonly data: Readonly<Record<string,string|number|boolean|null>>; readonly previousHash: string; readonly hash: string; }
export interface EvidenceLedger { append(type: EvidenceType, data: EvidenceEntry['data'], occurredAt: string): EvidenceEntry; entries(): readonly EvidenceEntry[]; verify(entries?: readonly EvidenceEntry[]): boolean; }

function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`; return JSON.stringify(value); }
function digest(unsigned: Omit<EvidenceEntry,'hash'>): string { return createHash('sha256').update(canonical(unsigned)).digest('hex'); }

export class InMemoryEvidenceLedger implements EvidenceLedger {
  readonly #entries: EvidenceEntry[] = [];
  append(type: EvidenceType, data: EvidenceEntry['data'], occurredAt: string): EvidenceEntry {
    const unsigned = { id: randomUUID(), sequence: this.#entries.length, type, occurredAt, data: Object.freeze({...data}), previousHash: this.#entries.at(-1)?.hash ?? 'GENESIS' } as const;
    const entry = Object.freeze({ ...unsigned, hash: digest(unsigned) }); this.#entries.push(entry); return entry;
  }
  entries(): readonly EvidenceEntry[] { return this.#entries.map((e)=>Object.freeze({...e, data:Object.freeze({...e.data})})); }
  verify(entries: readonly EvidenceEntry[] = this.#entries): boolean {
    let previous = 'GENESIS'; for (let i=0;i<entries.length;i++) { const e=entries[i]; if (!e || e.sequence!==i || e.previousHash!==previous) return false; const {hash,...unsigned}=e; if (digest(unsigned)!==hash) return false; previous=hash; } return true;
  }
}
