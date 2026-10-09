import { describe,expect,it } from 'vitest';
import { mandateFingerprint } from '../src/canonical.js';
import type { AgentPassport,Mandate,TransactionProposal } from '../src/domain.js';
import { InMemoryEvidenceLedger } from '../src/evidence.js';
import { AuthorizedPaymentExecutor,MockPaymentProvider } from '../src/payment.js';
import { TrustKernelService } from '../src/service.js';
const now='2026-10-09T12:00:00.000Z';
const mandate:Mandate={id:'m',principalId:'p',authorizedAgentId:'a',purpose:'keyboard',category:'KEYBOARD',currency:'USD',maxSingleTransactionMinor:10000,cumulativeLimitMinor:20000,allowedConditions:['NEW'],merchantRiskCeiling:'MEDIUM',autonomousPurchaseThresholdMinor:7500,humanApprovalThresholdMinor:10000,allowedCapabilities:['CREATE_ORDER'],createdAt:now,expiresAt:'2026-12-01T00:00:00.000Z',version:1,nonce:'mandate-nonce-0001'};
const agent:AgentPassport={id:'a',principalId:'p',displayName:'Agent',issuedAt:now,expiresAt:'2026-12-01T00:00:00.000Z',status:'ACTIVE',capabilities:['CREATE_ORDER']};
const make=(minor:number,id='tx'):TransactionProposal=>({id,agentId:'a',mandateId:'m',mandateFingerprint:mandateFingerprint(mandate),amount:{currency:'USD',minor},merchant:{id:'s',displayName:'Shop'},category:'KEYBOARD',condition:'NEW',requestedCapability:'CREATE_ORDER',proposedAt:now,nonce:`proposal-nonce-${id}`,metadata:{}});
function setup(){const ledger=new InMemoryEvidenceLedger();const provider=new MockPaymentProvider();const executor=new AuthorizedPaymentExecutor(provider,ledger);return{ledger,provider,service:new TrustKernelService(ledger,executor)};}
describe('authorization before financial side effects',()=>{
 it('DENY never invokes provider',async()=>{const {provider,service}=setup();const p=make(12000);const r=service.evaluate(mandate,agent,p,{now,merchantRisk:'LOW'});expect(r.decision).toBe('DENY');await expect(service.execute(p,r)).rejects.toThrow('PAYMENT_NOT_AUTHORIZED');expect(provider.createCalls).toBe(0);});
 it('ESCALATE never invokes provider without approval',async()=>{const {provider,service}=setup();const p=make(8000);const r=service.evaluate(mandate,agent,p,{now,merchantRisk:'LOW'});expect(r.decision).toBe('ESCALATE');await expect(service.execute(p,r)).rejects.toThrow('HUMAN_APPROVAL_REQUIRED');expect(provider.createCalls).toBe(0);});
 it('valid ALLOW invokes mock provider',async()=>{const {provider,service}=setup();const p=make(7000);const r=service.evaluate(mandate,agent,p,{now,merchantRisk:'LOW'});await service.execute(p,r);expect(provider.createCalls).toBe(1);});
 it('explicit approval enables original ESCALATE without mutating mandate',async()=>{const {provider,service,ledger}=setup();const p=make(8000);const r=service.evaluate(mandate,agent,p,{now,merchantRisk:'LOW'});service.approve(r,'p',now);await service.execute(p,r);expect(provider.createCalls).toBe(1);expect(ledger.entries().some(e=>e.type==='HUMAN_APPROVAL_GRANTED')).toBe(true);});
});
