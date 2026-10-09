import { describe,expect,it } from 'vitest';
import { InMemoryEvidenceLedger } from '../src/evidence.js';

describe('tamper-evident evidence ledger',()=>{
 it('verifies an intact chain',()=>{const l=new InMemoryEvidenceLedger();l.append('MANDATE_CREATED',{id:'m'},'2026-10-09T00:00:00.000Z');l.append('POLICY_EVALUATED',{decision:'ALLOW'},'2026-10-09T00:00:01.000Z');expect(l.verify()).toBe(true);});
 it('detects modified evidence',()=>{const l=new InMemoryEvidenceLedger();l.append('MANDATE_CREATED',{id:'m'},'2026-10-09T00:00:00.000Z');const es=l.entries();const bad=[{...es[0]!,data:{id:'evil'}}];expect(l.verify(bad)).toBe(false);});
 it('detects reordered evidence',()=>{const l=new InMemoryEvidenceLedger();l.append('MANDATE_CREATED',{id:'m'},'2026-10-09T00:00:00.000Z');l.append('POLICY_EVALUATED',{x:1},'2026-10-09T00:00:01.000Z');expect(l.verify([l.entries()[1]!,l.entries()[0]!])).toBe(false);});
});
