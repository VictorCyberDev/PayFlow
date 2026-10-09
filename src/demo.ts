import { mandateFingerprint } from './canonical.js';
import type { AgentPassport, Mandate, MerchantRisk, TransactionProposal } from './domain.js';
import { InMemoryEvidenceLedger } from './evidence.js';
import { authorize } from './kernel.js';

const now='2026-10-09T12:00:00.000Z';
const mandate: Mandate={id:'mandate-keyboard',principalId:'principal-victor',authorizedAgentId:'agent-shopper',purpose:'Purchase wireless keyboard',category:'KEYBOARD',currency:'USD',maxSingleTransactionMinor:10000,cumulativeLimitMinor:20000,allowedConditions:['NEW'],merchantRiskCeiling:'MEDIUM',autonomousPurchaseThresholdMinor:7500,humanApprovalThresholdMinor:10000,allowedCapabilities:['CREATE_ORDER'],createdAt:now,expiresAt:'2026-12-31T23:59:59.000Z',version:1,nonce:'mandate-nonce-0001'};
const agent: AgentPassport={id:'agent-shopper',principalId:'principal-victor',displayName:'Shopping Agent',issuedAt:now,expiresAt:'2026-12-01T00:00:00.000Z',status:'ACTIVE',capabilities:['CREATE_ORDER']};
const fp=mandateFingerprint(mandate);
function proposal(id:string,minor:number,condition:TransactionProposal['condition']='NEW'):TransactionProposal{return{id,agentId:agent.id,mandateId:mandate.id,mandateFingerprint:fp,amount:{currency:'USD',minor},merchant:{id:'merchant-demo',displayName:'Demo Merchant'},category:'KEYBOARD',condition,requestedCapability:'CREATE_ORDER',proposedAt:now,nonce:`proposal-nonce-${id}`,metadata:{}};}
function run(label:string,p:TransactionProposal,risk:MerchantRisk,override:Mandate=mandate){const receipt=authorize(override,agent,p,{now,merchantRisk:risk,cumulativeSpentMinor:0,replaySeen:false}); console.log(`\n${label}: ${receipt.decision}`); console.log(JSON.stringify(receipt,null,2));}
run('A $89 new acceptable merchant',proposal('A',8900),'LOW');
run('B $129 hard maximum',proposal('B',12900),'LOW');
run('C $64 refurbished',proposal('C',6400,'REFURBISHED'),'LOW');
run('D $94 excessive risk',proposal('D',9400),'EXCESSIVE');
run('E mutated mandate',proposal('E',8900),'LOW',{...mandate,maxSingleTransactionMinor:100000,humanApprovalThresholdMinor:100000});
run('F $80 above autonomous threshold',proposal('F',8000),'LOW');
const ledger=new InMemoryEvidenceLedger(); ledger.append('MANDATE_CREATED',{mandateId:mandate.id},now); ledger.append('POLICY_EVALUATED',{demo:true},now); console.log(`\nEvidence chain valid: ${ledger.verify()}`);
