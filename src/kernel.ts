import { randomUUID } from 'node:crypto';
import { AgentPassportSchema, MandateSchema, TransactionProposalSchema, type AgentPassport, type CheckResult, type DecisionCode, type DecisionReceipt, type Mandate, type MerchantRisk, type TransactionProposal } from './domain.js';
import { mandateFingerprint } from './canonical.js';

export const AUTHORIZATION_ENGINE_VERSION = 'payflow-trust-kernel/1.0';
const riskRank: Readonly<Record<MerchantRisk, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2, EXCESSIVE: 3 };

export interface AuthorizationContext { readonly now: string; readonly merchantRisk: MerchantRisk; readonly cumulativeSpentMinor: number; readonly replaySeen: boolean; }

const checkNames = ['mandate','mandateIntegrity','agentAuthority','capability','budget','cumulativeBudget','currency','category','condition','merchantRisk','replay'] as const;
function blankChecks(): Record<(typeof checkNames)[number], CheckResult> { return Object.fromEntries(checkNames.map((x) => [x, 'NOT_EVALUATED'])) as Record<(typeof checkNames)[number], CheckResult>; }

export function authorize(rawMandate: unknown, rawAgent: unknown, rawProposal: unknown, context: AuthorizationContext): DecisionReceipt {
  const m = MandateSchema.safeParse(rawMandate); const a = AgentPassportSchema.safeParse(rawAgent); const p = TransactionProposalSchema.safeParse(rawProposal);
  const checks = blankChecks();
  const fallback = (rawProposal !== null && typeof rawProposal === 'object') ? rawProposal as Record<string, unknown> : {};
  if (!m.success || !a.success || !p.success || !Number.isInteger(context.cumulativeSpentMinor) || context.cumulativeSpentMinor < 0) {
    return { receiptId: randomUUID(), decision: 'DENY', reasonCodes: ['MALFORMED_INPUT'], mandateId: m.success ? m.data.id : 'INVALID', mandateFingerprint: m.success ? mandateFingerprint(m.data) : 'INVALID', agentId: a.success ? a.data.id : 'INVALID', proposalId: typeof fallback.id === 'string' ? fallback.id : 'INVALID', amount: p.success ? p.data.amount : { currency: 'XXX', minor: 0 }, checks, evaluatedAt: context.now, authorizationEngineVersion: AUTHORIZATION_ENGINE_VERSION };
  }
  const mandate: Mandate = m.data; const agent: AgentPassport = a.data; const proposal: TransactionProposal = p.data;
  const reasons: DecisionCode[] = []; const now = Date.parse(context.now);
  const fail = (code: DecisionCode) => { if (!reasons.includes(code)) reasons.push(code); };
  checks.mandate = Number.isFinite(now) && now <= Date.parse(mandate.expiresAt) ? 'PASS' : 'FAIL'; if (checks.mandate === 'FAIL') fail('MANDATE_EXPIRED');
  const fp = mandateFingerprint(mandate); checks.mandateIntegrity = proposal.mandateId === mandate.id && proposal.mandateFingerprint === fp ? 'PASS' : 'FAIL'; if (checks.mandateIntegrity === 'FAIL') fail('MANDATE_INTEGRITY_FAILURE');
  const agentOk = agent.id === mandate.authorizedAgentId && agent.principalId === mandate.principalId && proposal.agentId === agent.id;
  checks.agentAuthority = agentOk && agent.status === 'ACTIVE' && now <= Date.parse(agent.expiresAt) ? 'PASS' : 'FAIL';
  if (!agentOk) fail('AGENT_UNAUTHORIZED'); if (agent.status === 'SUSPENDED' || agent.status === 'REVOKED') fail('AGENT_SUSPENDED'); if (now > Date.parse(agent.expiresAt)) fail('AGENT_EXPIRED');
  const cap = mandate.allowedCapabilities.includes(proposal.requestedCapability) && agent.capabilities.includes(proposal.requestedCapability);
  checks.capability = cap ? 'PASS' : 'FAIL'; if (!cap) fail('CAPABILITY_DENIED');
  checks.budget = proposal.amount.minor <= mandate.maxSingleTransactionMinor ? 'PASS' : 'FAIL'; if (checks.budget === 'FAIL') fail('AMOUNT_EXCEEDS_LIMIT');
  const cumulativeOk = mandate.cumulativeLimitMinor === undefined || context.cumulativeSpentMinor + proposal.amount.minor <= mandate.cumulativeLimitMinor;
  checks.cumulativeBudget = cumulativeOk ? 'PASS' : 'FAIL'; if (!cumulativeOk) fail('CUMULATIVE_LIMIT_EXCEEDED');
  checks.currency = proposal.amount.currency === mandate.currency ? 'PASS' : 'FAIL'; if (checks.currency === 'FAIL') fail('CURRENCY_MISMATCH');
  checks.category = proposal.category === mandate.category ? 'PASS' : 'FAIL'; if (checks.category === 'FAIL') fail('CATEGORY_DENIED');
  checks.condition = mandate.allowedConditions.includes(proposal.condition) ? 'PASS' : 'FAIL'; if (checks.condition === 'FAIL') fail('CONDITION_DENIED');
  checks.merchantRisk = riskRank[context.merchantRisk] <= riskRank[mandate.merchantRiskCeiling] ? 'PASS' : 'FAIL'; if (checks.merchantRisk === 'FAIL') fail('MERCHANT_RISK_TOO_HIGH');
  checks.replay = context.replaySeen ? 'FAIL' : 'PASS'; if (context.replaySeen) fail('REPLAY_DETECTED');
  const hardFailure = reasons.length > 0;
  let decision: DecisionReceipt['decision'];
  if (hardFailure) decision = 'DENY';
  else if (proposal.amount.minor > mandate.autonomousPurchaseThresholdMinor) { decision = 'ESCALATE'; reasons.push('HUMAN_APPROVAL_REQUIRED'); checks.budget = 'ESCALATE'; }
  else { decision = 'ALLOW'; reasons.push('ALLOWED'); }
  return { receiptId: randomUUID(), decision, reasonCodes: reasons, mandateId: mandate.id, mandateFingerprint: fp, agentId: agent.id, proposalId: proposal.id, amount: proposal.amount, checks, evaluatedAt: context.now, authorizationEngineVersion: AUTHORIZATION_ENGINE_VERSION };
}
