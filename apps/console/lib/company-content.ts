export interface CompanyDocument {
  title: string;
  intro: string;
  sections: { title: string; paragraphs: string[]; code?: string }[];
  links?: [string, string][];
}
const make = (
  title: string,
  intro: string,
  sections: CompanyDocument["sections"],
  links?: [string, string][],
): CompanyDocument => ({ title, intro, sections, ...(links ? { links } : {}) });
export const companyDocuments: Record<string, CompanyDocument> = {
  product: make(
    "Authority is the product.",
    "Payment credentials let a system authenticate. Financial Authority determines what it may actually do.",
    [
      {
        title: "Authority → Gateway",
        paragraphs: [
          "Bind principal, agent, merchant, item, amount, quantity and expiry. Gateway evaluates the exact action against existing Authority. ALLOW, DENY and ESCALATE are decisions; none is a capture receipt.",
          "The execution path reserves bounded capacity, issues a one-time grant and revalidates immediately before dispatch. Wallet consent remains an instrument, not permission.",
        ],
      },
      {
        title: "Verify → Proof",
        paragraphs: [
          "Verify checks a signed presentation for a particular audience and challenge. It does not need payment credentials or access to execution APIs.",
          "Proof connects Authority, action, decision and provider outcome. An UNKNOWN outcome requires reconciliation of the original attempt, not another purchase.",
        ],
      },
      {
        title: "Control → Network",
        paragraphs: [
          "Control models organizations, lifecycle, delegation and separation of duties. Enterprise controls and network interoperability remain local implementations awaiting operational commissioning.",
          "The Network demonstrator connects external identity, issuer, verifier and a simulated rail. No operating global network or real adoption is claimed.",
        ],
      },
    ],
    [
      ["Sandbox", "/sandbox/"],
      ["Evidence", "/evidence/"],
    ],
  ),
  solutions: make(
    "Build. Govern. Verify.",
    "One Authority truth across agents, organizations, merchants and rails.",
    [],
    [
      ["Agent builders", "/solutions/agent-builders/"],
      ["Finance & procurement", "/solutions/finance/"],
      ["Platforms & merchants", "/solutions/merchants/"],
    ],
  ),
  "solutions/agent-builders": make(
    "Give agents financial capability—not unrestricted financial power.",
    "Integrate where a proposed action could create a financial consequence.",
    [
      {
        title: "Build against an exact boundary",
        paragraphs: [
          "Use Gateway for actions, Verify for presentations and Proof for outcomes. Read-only checks must not reserve capacity or issue grants.",
          "The repository includes TypeScript and Python clients, local MCP/A2A implementations and procurement examples. Hosted commissioning and actual vendor model evaluations remain separate acceptance gates.",
        ],
      },
      {
        title: "Design for uncertainty",
        paragraphs: [
          "Persist the original attempt before dispatch. After a timeout, reconcile the same identity. A new idempotency key is a new financial risk.",
          "Your model cannot enlarge merchant scope, amount or expiry through tool arguments. Treat every argument as untrusted input.",
        ],
      },
    ],
    [
      ["Quickstart", "/docs/quickstart/"],
      ["MCP", "/docs/mcp/"],
      ["A2A", "/docs/a2a/"],
    ],
  ),
  "solutions/finance": make(
    "Automate execution. Keep financial control.",
    "Let agents execute financial work without surrendering financial control.",
    [
      {
        title: "Define routine work precisely",
        paragraphs: [
          "Bound approved suppliers, invoice context, currency, per-action and cumulative limits, quantity and expiry. Separate Authority creation from exceptional approval.",
          "An ERP record or natural-language instruction is not independently sufficient permission to move money.",
        ],
      },
      {
        title: "Evaluate with evidence",
        paragraphs: [
          "Review decision, exact action and provider outcome together. Denied attempts and uncertain outcomes must remain distinguishable.",
          "Enterprise modules exist locally. Production identity provisioning, ERP access and operational onboarding require commissioning. No enterprise customer is claimed.",
        ],
      },
    ],
    [
      ["Enterprise inquiry", "/contact/"],
      ["Security", "/security/"],
    ],
  ),
  "solutions/merchants": make(
    "Know whether the agent was authorized before money moves.",
    "Independent verification without sharing payment credentials.",
    [
      {
        title: "Verify the presentation",
        paragraphs: [
          "Check trusted issuer, signature, validity, revocation, audience and challenge. A presentation for one merchant must not become permission at another.",
          "The merchant SDK and portable verifier are in source. The Gate Mark is a visual identifier, never a substitute for verification.",
        ],
      },
      {
        title: "Keep the outcome separate",
        paragraphs: [
          "Authority verification establishes permission. Proof establishes observed effects. Neither should be inferred from the other.",
          "Real merchant pilots and independently operated verifiers remain pending.",
        ],
      },
    ],
    [
      ["Verify guide", "/docs/verify/"],
      ["Evidence", "/evidence/"],
    ],
  ),
  security: make(
    "Trust is inspectable.",
    "Developer preview. No independent audit, certification, standards membership or production uptime is claimed. Each control below says whether it is in source, tested or deployed.",
    [
      {
        title: "One decision path",
        paragraphs: [
          "Every protocol and client reaches the same Trust Kernel. A model cannot authorize its own spending, a credential does not grant Authority, and an agent cannot widen, extend or reactivate what it was given. Execution needs an exact reservation and a one-time grant, and the Execution Boundary re-checks Authority immediately before any provider call.",
        ],
      },
      {
        title: "Credentials",
        paragraphs: [
          "Hosted access uses scoped, expiring tokens bound to one organization, environment, agent and principal. Only a SHA-256 digest is stored; the secret is shown once and can be revoked, after which the next request fails closed. Suspending an agent or an organization stops access at once. Tested in source; the hosted preview ran one revoked-credential check on 2026-11-02.",
        ],
      },
      {
        title: "Replay and concurrency",
        paragraphs: [
          "The first presentation of a request identity wins and every repeat is refused with no second effect. Concurrent requests cannot overspend an Authority. Both were exercised against PayPal Sandbox on 2026-11-02.",
        ],
      },
      {
        title: "UNKNOWN",
        paragraphs: [
          "If a provider does not answer, the outcome is UNKNOWN, never failed, and the amount stays held. Nothing is retried automatically. Operators have an observe-only view of unresolved payments.",
        ],
      },
      {
        title: "Proof and independent verification",
        paragraphs: [
          "A signed portable Proof binds the Authority, agent, amount, currency, merchant and outcome. Anyone can verify it offline with a public key, so you do not have to trust the PayFlow session or database. In source and tested; not yet deployed.",
        ],
      },
      {
        title: "Operations (in source, not deployed)",
        paragraphs: [
          "Per-credential rate limits that hold across serverless instances, operator pauses for one organization, one environment or everything (no public endpoint can set them), an append-only audit trail enforced by the database, and organization isolation tests. Backup restore has not been rehearsed. There is one signing key and one database role.",
        ],
      },
      {
        title: "Adversarial evidence",
        paragraphs: [
          "1,000 scenarios from 16 attack families, with the exact limits stated, run against the production modules and a fake rail. No real model was run and no third party has reproduced it.",
        ],
      },
      {
        title: "Reporting a vulnerability",
        paragraphs: [
          "Use the Security category on the contact page and ask for a private channel. Please do not post exploit details or secrets publicly. No bounty and no response time is promised yet.",
        ],
      },
      {
        title: "Limits you should know",
        paragraphs: [
          "Encryption of the stored wallet uses AES-256-GCM; signing keys and provider credentials stay server-side. Output filtering is a supplement, not a data-loss guarantee. The hosted preview is protected and not public. OAuth/OIDC for end users is not built.",
        ],
      },
    ],
    [
      ["Break Authority evidence", "/research/break-authority/"],
      [
        "Threat model",
        "https://github.com/VictorCyberDev/PayFlow/blob/claude/eloquent-einstein-dw0mxk/docs/security-ops/THREAT-MODEL-UPDATE.md",
      ],
      [
        "Security policy",
        "https://github.com/VictorCyberDev/PayFlow/blob/claude/eloquent-einstein-dw0mxk/SECURITY.md",
      ],
      ["Contact", "/contact/"],
    ],
  ),
  status: make(
    "Service status",
    "Measured facts only. No uptime monitoring exists yet, so availability and uptime are not stated.",
    [
      {
        title: "Hosted API (Gateway, Proof, Verify)",
        paragraphs: [
          "Deployed once as a protected preview for commissioning on 2026-11-02 (commit 540f10f). It is not publicly reachable and carries no availability claim.",
        ],
      },
      {
        title: "Last commissioning evidence (not uptime)",
        paragraphs: [
          "On 2026-11-02 one PayPal Sandbox purchase went through the hosted Gateway and completed exactly once. A replay, three concurrent overruns, a revoked credential and a revoked Authority each moved $0. This shows the path worked on that day. It measures nothing about reliability.",
        ],
      },
      {
        title: "Public site",
        paragraphs: ["Static pages. No health probe is configured."],
      },
      {
        title: "External dependencies",
        paragraphs: [
          "PayPal Sandbox was exercised once on 2026-11-02. No provider health is inferred from that.",
        ],
      },
      {
        title: "Before operational launch",
        paragraphs: [
          "Configure authenticated probes, component ownership and incident updates, then observe for a stated window. Publish uptime only after it has been measured.",
        ],
      },
    ],
    [
      [
        "Commissioning record",
        "https://github.com/VictorCyberDev/PayFlow/blob/claude/eloquent-einstein-dw0mxk/docs/evidence/live/m7-sandbox-acceptance-2026-11-02.json",
      ],
      [
        "Incident process",
        "https://github.com/VictorCyberDev/PayFlow/blob/claude/eloquent-einstein-dw0mxk/docs/security-ops/INCIDENT-RUNBOOKS.md",
      ],
    ],
  ),
  pricing: make(
    "Start with a boundary.",
    "Free to evaluate in the Sandbox. Commercial prices are a hypothesis: none is validated, none is offered, and there is no paid checkout.",
    [
      {
        title: "Sandbox / Free",
        paragraphs: [
          "Evaluate the Authority, the Execution Boundary and Proof against PayPal Sandbox. No payment details. Hosted use needs a credential and is rate limited. No real money.",
        ],
      },
      {
        title: "Platform / Usage-based (hypothesis)",
        paragraphs: [
          "The intended model charges per governed action: an authenticated, well-formed, non-replayed request that PayFlow evaluated. Rates, included usage and minimums are not set, and willingness to pay has not been tested with anyone. The meter exists in source and is not billing anyone.",
        ],
      },
      {
        title: "Enterprise / Negotiated (hypothesis)",
        paragraphs: [
          "A platform fee plus governance controls and support, scoped with you. Identity integration, audit, support level and retention are discussed case by case. No certification and no delivery commitment is implied.",
        ],
      },
      {
        title: "Verify / Free or low-friction (hypothesis)",
        paragraphs: [
          "Checking a Proof stays cheap or free where it strengthens trust: you can already verify a Proof offline with no account.",
        ],
      },
      {
        title: "What we have not decided",
        paragraphs: [
          "We do not price as a share of payment volume: that raises regulatory and incentive questions we have flagged for qualified counsel. No price will be published before real conversations and a legal review have happened.",
        ],
      },
    ],
    [
      ["Verify a Proof for free", "/verify/"],
      ["Tell us what you would pay for", "/contact/"],
      [
        "How we reason about pricing",
        "https://github.com/VictorCyberDev/PayFlow/blob/claude/eloquent-einstein-dw0mxk/docs/economics/PRICING-ARCHITECTURE.md",
      ],
    ],
  ),
  company: make(
    "One authority truth.",
    "PayFlow builds financial authority for autonomous systems. Protocol identifiers and financial evidence stay independent of future naming decisions.",
    [
      {
        title: "Any agent. Any rail.",
        paragraphs: [
          "A person should benefit even when another company supplies their agent, identity, merchant platform and payment rail.",
          "Our current credibility is the evidence: replay, drift, revocation, concurrency, UNKNOWN and tampered Proof. No invented customer logos, volume or revenue.",
        ],
      },
      {
        title: "Current stage",
        paragraphs: [
          "Developer preview, local network demonstrators and historical Sandbox evidence. M6 remains an independent acceptance gate. Registration, contracts and production operations are not represented as complete.",
        ],
      },
    ],
    [
      ["Contact", "/contact/"],
      ["Research", "/research/"],
      ["Changelog", "/changelog/"],
    ],
  ),
  evidence: make(
    "Know what is real.",
    "Accepted history, current local tests and external commissioning are different evidence classes.",
    [
      {
        title: "Accepted historical evidence",
        paragraphs: [
          "Accepted M4 PayPal Sandbox, post-M4 exactly-once work and M5 Authority Experience remain preserved in history. They are not M6 delegated acceptance or production volume.",
          "Main baseline: 880a890f9e0735d03ee7e0de625907e408f5fc73. Inspect closure documents and provenance before reusing claims.",
        ],
      },
      {
        title: "Current local evidence",
        paragraphs: [
          "M7–M60 adds Gateway, Verify, SDKs, enterprise controls, federation and adversarial artifacts. Integrated Break Authority reports use a deterministic fake rail. No provider is contacted.",
          "Starting head 6bcab82 has recorded green CI run 40659651703. New changes require their own exact-head validation.",
        ],
      },
      {
        title: "External pending",
        paragraphs: [
          "M6 capture; hosted MCP/OAuth; ChatGPT connection/submission; vendor model evaluations; remote A2A peer and conformance tooling; real second/third rail; pilots, audits and standards participation.",
        ],
      },
    ],
    [
      ["Benchmark methodology", "/research/break-authority/"],
      ["Repository", "https://github.com/VictorCyberDev/PayFlow"],
      [
        "Draft integration PR",
        "https://github.com/VictorCyberDev/PayFlow/pull/18",
      ],
    ],
  ),
  changelog: make(
    "Changelog",
    "Each entry says how far a change has actually travelled: built, tested, deployed, commissioned or externally validated.",
    [
      {
        title: "2026-11-02 / M9 Break Authority research page",
        paragraphs: [
          "BUILT and TESTED in source. Not deployed. 1,000 scenarios from 16 attack families produce 38 distinct containment outcomes; the rail is a fake and no real model was run. COMMISSIONED: no. EXTERNALLY VALIDATED: no.",
        ],
      },
      {
        title: "2026-11-02 / M8 independent Verify",
        paragraphs: [
          "BUILT and TESTED in source. Not deployed. Signed portable proof that binds agent, amount, currency and merchant; offline CLI with a plain-language result; SDK verify; in-browser verifier. Tamper, wrong-key, unknown-key, historical, UNKNOWN and read-only-import cases pass. COMMISSIONED: no. EXTERNALLY VALIDATED: no.",
        ],
      },
      {
        title: "2026-11-02 / M7 external Gateway execution",
        paragraphs: [
          "BUILT and TESTED. DEPLOYED as a protected preview (commit 540f10f). COMMISSIONED: one PayPal Sandbox capture through the hosted Gateway, with replay, concurrent-overrun, revoked-credential and revoked-Authority checks. EXTERNALLY VALIDATED: no. Not publicly reachable; Sandbox only.",
        ],
      },
      {
        title: "2026-10-29 / Company work in progress",
        paragraphs: [
          "Company and app separation, corrected milestone classifications and protocol transport corrections. Source work, not a release.",
        ],
      },
      {
        title: "2026-10-28 / Integration candidate",
        paragraphs: [
          "Gateway, Verify, SDKs, enterprise modules, reconciliation, portable verification and local adversarial artifacts. External publication was pending.",
        ],
      },
    ],
    [["Source history", "https://github.com/VictorCyberDev/PayFlow/pull/19"]],
  ),
  privacy: make(
    "Privacy Policy / Draft",
    "Launch baseline 2026-10-29. Requires legal review before commercial production use.",
    [
      {
        title: "Data and purposes",
        paragraphs: [
          "Authenticated services may process principal/agent identifiers, Authority, action requests, sessions, provider references, evidence and support correspondence for authorization, execution, reconciliation and support. Do not send credentials in model prompts.",
          "The public illustration contacts no provider. No third-party behavioral analytics or advertising tracker has been added.",
        ],
      },
      {
        title: "Retention and requests",
        paragraphs: [
          "Financial evidence may survive profile deletion. Retention periods, legal basis and controller identity require final review. Use Contact for information, correction or deletion review. No jurisdiction-specific fulfillment SLA is promised.",
        ],
      },
    ],
    [
      ["Contact", "/contact/"],
      ["Subprocessors", "/subprocessors/"],
    ],
  ),
  terms: make(
    "Terms of Use / Draft",
    "Launch baseline 2026-10-29. Legal review required. Templates do not establish regulatory compliance.",
    [
      {
        title: "Developer preview",
        paragraphs: [
          "Sandbox examples are for evaluation. Simulated evidence is not a payment receipt. Do not rely on preview availability for production obligations.",
        ],
      },
      {
        title: "Financial responsibility",
        paragraphs: [
          "Only an authorized principal can grant Authority. Users remain responsible for lawful instructions, valid provider access and review of boundaries. This preview is not represented as a bank, custodian or PSP.",
        ],
      },
      {
        title: "Outstanding commercial terms",
        paragraphs: [
          "Contracting entity, warranties, service levels, liability, dispute provisions and jurisdiction require legal review and explicit agreement. No customer contract or regulatory approval is asserted.",
        ],
      },
    ],
    [
      ["Acceptable use", "/acceptable-use/"],
      ["Contact", "/contact/"],
    ],
  ),
  "acceptable-use": make(
    "Acceptable Use Policy / Draft",
    "Use only legitimate Authority and lawful provider access. Legal review remains pending.",
    [
      {
        title: "Prohibited activity",
        paragraphs: [
          "Do not bypass another person's limits, impersonate issuers, forge Proof, replay grants, steal secrets, evade legal restrictions or test third parties without permission.",
        ],
      },
      {
        title: "Research",
        paragraphs: [
          "Use local fixtures and your own Sandbox accounts. Preserve evidence without exposing personal or payment data. Request a private disclosure channel before sharing exploit details.",
        ],
      },
    ],
  ),
  subprocessors: make(
    "Data processing disclosure / Draft",
    "Architecture disclosure, not a signed DPA or certified subprocessor register.",
    [
      {
        title: "Hosting and storage",
        paragraphs: [
          "Historical acceptance uses Vercel and PostgreSQL. The company release has not been deployed by this session. Confirm actual database operator, region, retention and contract before onboarding.",
        ],
      },
      {
        title: "Providers",
        paragraphs: [
          "PayPal receives data only on commissioned provider paths. OpenAI, Anthropic and Google tool loops are opt-in client integrations. Source availability does not establish live data sharing, account access or provider terms.",
        ],
      },
      {
        title: "Legal work",
        paragraphs: [
          "Finalize controller/processor roles, contracting entity, provider regions, transfer mechanisms, retention, deletion and incident obligations before production.",
        ],
      },
    ],
  ),
  sandbox: make(
    "An exact boundary. A visible outcome.",
    "Explore the boundary in your browser with no account, then call the hosted Sandbox with a credential. Sandbox only: no real money moves.",
    [
      {
        title: "In your browser, no account",
        paragraphs: [
          "Use the interactive illustration below, and check a sample Proof on the Verify page. Both run locally and contact no provider.",
        ],
      },
      {
        title: "Against the hosted Sandbox",
        paragraphs: [
          "Hosted execution runs on PayPal Sandbox through the same Trust Kernel as production design. It needs a PayFlow credential. Self-serve credentials are not available yet: request one through Contact and say which agent and use case you have in mind.",
        ],
      },
      {
        title: "What you do with a credential",
        paragraphs: [
          "Send an allowed purchase and see it paid once. Change the amount or merchant and see $0 moved with a reason you can act on. Open the Proof, then verify it offline with no PayFlow session.",
        ],
      },
      {
        title: "Limits you should know",
        paragraphs: [
          "Preview only. One controlled demo merchant. No uptime commitment. Credentials expire and can be revoked.",
        ],
      },
    ],
    [
      ["Verify a Proof", "/verify/"],
      ["Quickstart", "/docs/quickstart/"],
      ["Request a credential", "/contact/"],
    ],
  ),
  contact: make(
    "Talk to us.",
    "Tell us what your agent needs to do and where financial control must remain.",
    [
      {
        title: "Keep the first inquiry simple",
        paragraphs: [
          "Choose developer, design-partner, enterprise or security. This form opens an email draft, not a delivery confirmation. Do not include credentials, payment data or confidential vulnerabilities. Request a private channel first.",
        ],
      },
    ],
  ),
  support: make(
    "Get help",
    "Choose the category so it reaches the right person. This is a developer preview: there is no response-time commitment.",
    [
      {
        title: "Integration",
        paragraphs: [
          "Credentials, SDK use, request shape, errors. Include the request id from the response. Never include a token.",
        ],
      },
      {
        title: "Authority and execution",
        paragraphs: [
          "An action was denied, or you expected it to be allowed. Include the reason and operation id.",
        ],
      },
      {
        title: "UNKNOWN or a payment question",
        paragraphs: [
          "If a result says we are confirming whether money moved, do not retry. Send the operation id and we will reconcile the original attempt. Nothing is re-executed.",
        ],
      },
      {
        title: "Verification",
        paragraphs: [
          "A Proof will not verify, or you need a key. Include the proof and the key id, never a private key.",
        ],
      },
      {
        title: "Security",
        paragraphs: [
          "Use the security category and ask for a private channel before sending details. Do not post exploit details publicly.",
        ],
      },
      {
        title: "Billing, account, partnership, general",
        paragraphs: [
          "Billing and account questions are limited while there is no paid plan. Partnership and design-partner interest goes in the partnership category.",
        ],
      },
      {
        title: "Ownership today",
        paragraphs: [
          "The founders read every request. No on-call rotation exists yet.",
        ],
      },
    ],
    [
      ["Contact form", "/contact/"],
      [
        "Security policy",
        "https://github.com/VictorCyberDev/PayFlow/blob/claude/eloquent-einstein-dw0mxk/SECURITY.md",
      ],
    ],
  ),
  docs: make(
    "Build at the financial boundary.",
    "Evaluate exact actions and inspect evidence. The local path requires no paid model or payment account.",
    [
      {
        title: "Integration contract",
        paragraphs: [
          "A principal grants bounded Authority. An authenticated agent proposes an exact action. The kernel decides. Execution consumes a one-time grant. Proof preserves observed outcomes. The model remains outside this boundary.",
        ],
      },
    ],
    [
      ["Quickstart", "/docs/quickstart/"],
      ["API & errors", "/docs/api/"],
      ["SDKs", "/docs/sdk/"],
      ["MCP", "/docs/mcp/"],
      ["A2A", "/docs/a2a/"],
      ["Verify & Proof", "/docs/verify/"],
      ["UNKNOWN", "/docs/unknown/"],
      ["Auth & scopes", "/docs/auth/"],
      ["Events & webhooks", "/docs/events/"],
      ["Threat model", "/docs/threat-model/"],
    ],
  ),
  "docs/quickstart": make(
    "First safe action",
    "Send a bounded purchase, break the Authority on purpose, then verify the Proof. The under-five-minutes target has not been measured.",
    [
      {
        title: "1. Get a credential",
        paragraphs: [
          "Ask for a Sandbox credential through Contact. You receive a token that is bound to one agent, with scopes and an expiry. PayFlow stores only its digest; the secret is shown once.",
        ],
      },
      {
        title: "2. Send an allowed action",
        paragraphs: [
          "amount is in minor units (cents) and is only checked against the trusted price. nonce is your idempotency key: reuse it to retry the same request safely.",
        ],
        code: 'import { PayFlowClient } from "@payflow/authority-sdk";\nconst payflow = new PayFlowClient({ baseUrl, accessToken });\nconst r = await payflow.actions.execute({\n  authority, agent, item: "Quiet keyboard",\n  amount: 8400, currency: "USD",\n  merchant: "payflow.demo.merchant", nonce: "order-0001",\n});\n// r.status === "COMPLETED"  ->  $84 paid once',
      },
      {
        title: "3. Break it on purpose",
        paragraphs: [
          "Ask for a different amount. Nothing is reserved and the provider is never called.",
        ],
        code: 'await payflow.actions.execute({ /* same */ amount: 18400, nonce: "order-0002" });\n// status "DENIED", effectCount 0, reason, recoverable, nextAction',
      },
      {
        title: "4. Read the result honestly",
        paragraphs: [
          "effectCount 1 means paid once. 0 means PayFlow is certain nothing moved. null means unknown: do not retry, read the Proof later.",
        ],
      },
      {
        title: "5. Inspect and verify the Proof",
        paragraphs: [
          "Fetch the portable Proof and the public keys, then check them offline.",
        ],
        code: 'curl -H "authorization: Bearer $TOKEN" $URL/v1/proofs/$ID/portable > proof.json\ncurl $URL/v1/keys > keys.json\npayflow verify proof.json --key keys.json',
      },
      {
        title: "Or reproduce the kernel locally",
        paragraphs: ["No credential, hosted service or paid model is needed."],
        code: "git clone https://github.com/VictorCyberDev/PayFlow.git\ncd PayFlow && git checkout claude/eloquent-einstein-dw0mxk\nnpm ci && npm test && npm run evidence:check",
      },
    ],
    [
      ["API & errors", "/docs/api/"],
      ["Verify & Proof", "/docs/verify/"],
      ["Credential help", "/support/"],
    ],
  ),
  "docs/api": make(
    "API & error reference",
    "Schema: openapi/payflow-v1.yaml, checked against the running handlers by tests. Hosted use needs a credential.",
    [
      {
        title: "Execute",
        paragraphs: [
          "POST /v1/actions/execute takes an Authority, agent, item, claimed amount, currency, merchant and a nonce. Policy outcomes are HTTP 200 with a structured body: ALLOW (COMPLETED), DENY, ESCALATE (NEEDS_APPROVAL) or UNRESOLVED. Read reason, recoverable and nextAction.",
        ],
      },
      {
        title: "effectCount",
        paragraphs: [
          "1: exactly one provider effect. 0: PayFlow is certain none occurred. null: unknown, never zero. A 5xx or a transport failure after sending is unknown, not zero.",
        ],
      },
      {
        title: "Errors at the door",
        paragraphs: [
          "400 malformed, 401 credential missing, unknown, expired or revoked, 403 wrong scope or not bound to this agent, 404 unknown Authority. All carry effectCount 0 and a nextAction. Never retry a financial write with a new nonce after a timeout.",
        ],
      },
      {
        title: "Replay",
        paragraphs: [
          "The first presentation of a nonce wins. A repeat returns REPLAY_DETECTED and never pays twice.",
        ],
      },
      {
        title: "Other routes",
        paragraphs: [
          "GET /v1/proofs/{id}, GET /v1/proofs/{id}/portable, GET /v1/keys. Credential routes are administrative.",
        ],
      },
    ],
    [
      [
        "OpenAPI source",
        "https://github.com/VictorCyberDev/PayFlow/blob/claude/eloquent-einstein-dw0mxk/openapi/payflow-v1.yaml",
      ],
    ],
  ),
  "docs/sdk": make(
    "SDK reference",
    "TypeScript and Python clients live in packages/sdk-typescript and packages/sdk-python.",
    [
      {
        title: "Tested journeys",
        paragraphs: [
          "The TypeScript SDK → REST → Gateway → Kernel journey is exercised in tests/m7-sdk-rest-openapi.test.ts. Python unittest cases live under packages/sdk-python/tests. Use those executable references for exact method signatures.",
          "Keep signing keys and provider credentials server-side. Pass only scoped access into an agent runtime. Never bundle server tokens into browser code.",
        ],
      },
      {
        title: "Portable verifier",
        paragraphs: [
          "packages/verifier contains independent verification and a CLI. Configure trusted issuer material explicitly; a supplied public key is not automatically trusted.",
        ],
      },
    ],
    [
      [
        "SDK source",
        "https://github.com/VictorCyberDev/PayFlow/tree/claude/eloquent-einstein-dw0mxk/packages",
      ],
    ],
  ),
  "docs/mcp": make(
    "MCP integration",
    "Five tools, separate read/write scopes. Local testing is not registry publication or ChatGPT approval.",
    [
      {
        title: "Tool surface",
        paragraphs: [
          "check_financial_authority checks without reserving; request_authorized_action requests deterministic evaluation; verify_authority checks signed presentations; verify_financial_proof checks evidence; reconcile_financial_action investigates the original attempt.",
        ],
      },
      {
        title: "HTTP and auth",
        paragraphs: [
          "HTTP handling validates Origin, JSON, payload bounds, protocol version and request metadata; it applies request IDs, rate limits and identity-bound scopes. Local servers bind loopback.",
          "Production requires TLS, durable rate/replay state, tenant-bound services and a commissioned OAuth issuer. ChatGPT needs protected-resource metadata, S256 PKCE and resource-bound tokens. A static key is not sufficient for that end-user flow.",
        ],
      },
    ],
    [
      ["Auth & scopes", "/docs/auth/"],
      ["Evidence", "/evidence/"],
    ],
  ),
  "docs/a2a": make(
    "A2A integration",
    "Local synchronous HTTP+JSON profile for A2A v1.0. Streaming and push notifications are not advertised.",
    [
      {
        title: "Discovery and message",
        paragraphs: [
          "Discover /.well-known/agent-card.json. Send A2A-Version: 1.0 and authenticated POST /a2a/v1/message:send with one structured data part containing a PayFlow tool and arguments. Response is an agent message.",
          "This profile does not claim long-running task support. Delegation is compared to a server-owned parent and never replaces principal Authority.",
        ],
      },
      {
        title: "Safety",
        paragraphs: [
          "Audience, expiry, attenuation and replay precede evaluation. Production needs durable replay storage and independently operated peers. Local HTTP compatibility is not remote interoperability certification.",
        ],
      },
    ],
  ),
  "docs/verify": make(
    "Verify Authority. Verify Proof.",
    "Permission before execution and evidence afterward answer different questions.",
    [
      {
        title: "Verify a Proof with nothing from PayFlow but a public key",
        paragraphs: [
          "A portable Proof is signed with Ed25519 over a canonical form. It carries the Authority, action, outcome, effect count and, when present, the agent, amount, currency and merchant. Changing any of them breaks the signature.",
        ],
      },
      {
        title: "Four ways",
        paragraphs: [
          "In your browser on the Verify page. With the CLI: payflow verify proof.json --key keys.json. With the SDK: payflow.proofs.verify(proof). Or with any Ed25519 library using the key from GET /v1/keys. Merchants can add --expect-amount, --expect-merchant and --expect-agent.",
        ],
      },
      {
        title: "Old proofs stay valid",
        paragraphs: [
          "Authenticity does not expire. Freshness is a separate, optional check (--max-age). A proof dated in the future is always refused.",
        ],
      },
      {
        title: "UNKNOWN",
        paragraphs: [
          "An unresolved outcome is signed as UNKNOWN with no effect count. It can never verify as a success.",
        ],
      },
      {
        title: "Authority at presentation time",
        paragraphs: [
          "Checking that an agent's Authority is current when it presents it to a merchant is a different check: signature, issuer, audience, challenge, expiry, revocation and replay, with no money-moving capability.",
        ],
      },
    ],
    [
      ["Verify in the browser", "/verify/"],
      [
        "Verifier source",
        "https://github.com/VictorCyberDev/PayFlow/blob/claude/eloquent-einstein-dw0mxk/packages/verifier",
      ],
    ],
  ),
  "docs/unknown": make(
    "We haven't confirmed whether money moved.",
    "Don't retry this action. We're checking the original attempt.",
    [
      {
        title: "Preserve uncertainty",
        paragraphs: [
          "A request may reach the provider while its response is lost. UNKNOWN is neither a confirmed failure nor success. Keep original attempt time, provider, Authority, action digest and idempotency identity.",
        ],
      },
      {
        title: "Next safe action",
        paragraphs: [
          "Look up the original provider reference. Record each reconciliation attempt and next lookup. Resolve only from terminal provider evidence and preserve the resolution in Proof.",
          "Do not release a reservation because a request timed out. Do not map UNKNOWN to FAILED or enable a new purchase retry. Show the next safe action instead of an endless spinner.",
        ],
      },
    ],
  ),
  "docs/auth": make(
    "Authenticate identity. Bound capability.",
    "Transport access does not grant financial Authority.",
    [
      {
        title: "PayFlow credentials (preview)",
        paragraphs: [
          "A bearer token pf_sbx_<id>.<secret>. Bound to one tenant, environment, agent and principal, with scopes, an audience and an expiry. Only a SHA-256 digest is stored; the secret is shown once. Revoke it and the next request fails closed. A suspended agent loses access at once.",
        ],
      },
      {
        title: "Scopes",
        paragraphs: [
          "authority:read, action:request, proof:read, verify:read, reconcile:request. The principal always comes from the agent record, never from the request.",
        ],
      },
      {
        title: "What a credential cannot do",
        paragraphs: [
          "It cannot widen an Authority, change a limit, pick a different principal, or skip the Trust Kernel. Unknown request fields are rejected.",
        ],
      },
      {
        title: "Production path",
        paragraphs: [
          "OAuth/OIDC with fixed issuer, audience and key set is the intended production path and is not built into the hosted preview.",
        ],
      },
    ],
    [["Support", "/support/"]],
  ),
  "docs/events": make(
    "Events & webhooks",
    "An event announces a transition. It is not independent provider truth.",
    [
      {
        title: "Consumption",
        paragraphs: [
          "Deduplicate event IDs, retain original attempt references and tolerate duplicates/reordering. UNKNOWN must not trigger another execution.",
        ],
      },
      {
        title: "Current boundary",
        paragraphs: [
          "Versioned envelopes exist in source. Production delivery, subscriber ownership, signature rotation, durable retries and monitoring remain commissioning work.",
        ],
      },
    ],
  ),
  "docs/threat-model": make(
    "Threat model",
    "Model, agent arguments, merchant claims, external issuers and provider responses are distinct trust boundaries.",
    [
      {
        title: "Primary threats",
        paragraphs: [
          "Prompt injection, scope widening, replay, revocation, reservation races, forged Proof, untrusted issuers and ambiguous outcomes must fail safely.",
          "Local adversarial tests exercise production modules using explicit simulated rails. They do not certify every deployed identity, provider or operational dependency.",
        ],
      },
    ],
    [
      ["Security center", "/security/"],
      ["Benchmark", "/research/break-authority/"],
    ],
  ),
};
export const researchArticles: [string, string, string, string[]][] = [
  [
    "financial-authority",
    "Financial authority for AI agents",
    "Permission must survive the move from intent to consequence.",
    [
      "Understanding a request does not grant permission to execute it. Financial Authority binds principal, agent, counterparty, item, currency, amount, quantity and expiry. A budget alone leaves most of that intent unspecified.",
      "The boundary must remain deterministic when a model changes its plan. A new item or merchant needs evaluation of the changed action. Reusing an earlier approval is authority drift.",
      "Bound, Gate, Commit and Verify separate instruction, decision, execution and evidence. Provider truth arrives after dispatch. It must never be replaced by model confidence.",
    ],
  ],
  [
    "credentials",
    "Why agent payment credentials are not authority",
    "Ability to authenticate is not permission to spend.",
    [
      "Credentials rarely encode one keyboard, an approved merchant and a maximum price. Giving an agent a provider secret makes those constraints advisory unless another boundary enforces them.",
      "Wallet consent has the same limit. A principal may approve an instrument once while requiring each subsequent action to remain within separate Authority.",
      "Keep credentials behind execution. Models propose structured arguments; the kernel evaluates them; provider credentials are used only after a bounded grant is consumed.",
    ],
  ],
  [
    "human-not-present",
    "Human-not-present commerce and delegated financial authority",
    "Absence at execution must not mean absence of control.",
    [
      "A person can authorize a precise class of future actions without approving every compliant transaction. The standing instruction still cannot become unrestricted financial power.",
      "ALLOW and ESCALATE must remain different. Wallet readiness cannot turn exceptional requests into autonomous execution. Revocation and expiry apply even when no human is present.",
      "PayFlow M6 requires an owner-approved Sandbox instrument and a later bounded capture without asking again. Until live evidence is recorded, local tests do not make this accepted.",
    ],
  ],
  [
    "zero-moved",
    "Why $0 moved cannot be inferred from an API error",
    "A lost response describes the network, not necessarily the money.",
    [
      "A timeout may occur before request arrival, after order creation or after capture. The same exception can describe all three. Calling it FAILED and enabling a fresh purchase risks duplicate effects.",
      "UNKNOWN preserves missing information. Keep original attempt, reservation, grant and idempotency identity connected while reconciliation looks up provider state.",
      "A denied action before dispatch can establish no provider effect. A transport error after dispatch cannot. Outcome copy must reflect that distinction.",
    ],
  ],
  [
    "exactly-once",
    "Exactly-once execution for autonomous finance",
    "Exactly once is a boundary property.",
    [
      "Concurrent agents, retries and lost responses require durable action identity, atomic reservations, one-time grants, provider idempotency and reconciliation. No single component suffices.",
      "Clients retain the original identity. Servers prevent racing capacity claims. Execution consumes a grant once. Provider adapters preserve the original reference through ambiguity.",
      "Adversarial tests demonstrate controlled faults. Real provider acceptance separately establishes observed effects and replay behavior. Never merge these into one unqualified success claim.",
    ],
  ],
  [
    "models",
    "Why models cannot authorize themselves",
    "A convincing explanation remains untrusted input.",
    [
      "If model reasoning can expand the limits it is evaluated against, the financial boundary disappears. Prompt injection becomes an authorization path.",
      "Store trusted Authority in principal-owned state. Bind identity from verified claims, validate arguments strictly and make read-only tools incapable of granting execution.",
      "Tool selection and authorization safety need separate measurement. A model may choose badly while the kernel safely denies. Both results matter.",
    ],
  ],
  [
    "portable-proof",
    "Portable Proof for autonomous financial actions",
    "Evidence should remain useful outside its originating application.",
    [
      "Operators, merchants and auditors need to inspect the same financial story. Portable Proof connects Authority, exact action, Gate decision and observed effects.",
      "A signature establishes signer and integrity. It does not make that issuer trusted or its financial claim true. Trust roots, revocation and reconciliation remain required.",
      "A verifier should require no execution credentials. Portability also requires identifier minimization. It is not permission to publish raw financial records.",
    ],
  ],
  [
    "delegation",
    "Delegation between agents",
    "Children cannot inherit more than the parent was allowed.",
    [
      "Delegation can narrow actions, currencies, counterparties, amount and expiry. It must preserve principal and connect to a trusted parent.",
      "A peer-supplied parent is not a root of trust. Load trusted parent state, bind audience and enforce expiry and replay before financial evaluation.",
      "Wire compatibility and authority conservation are different properties. A card describes a service; it does not prove another agent can authenticate and exchange valid messages. Test both.",
    ],
  ],
  [
    "rails",
    "Why payment rails should not define Authority",
    "Change execution provider without changing permission.",
    [
      "Providers determine how an effect is requested and observed. Authority determines whether it is permitted. Combining them turns each provider switch into policy migration.",
      "Adapters accept exact actions and bounded grants, preserve idempotency, normalize evidence and support lookup without re-execution. UNKNOWN survives every translation.",
      "Two fake rail names are not two providers. Local substitutes and historical PayPal evidence remain distinct from commissioning a genuine second rail.",
    ],
  ],
  [
    "break-authority",
    "Break Authority 1000 methodology",
    "A reproducible local adversarial benchmark with explicit limits.",
    [
      "Kernel and integrated 100/1000 reports live under docs/evidence. Integrated scenarios exercise production modules across 16 categories with valid controls, including drift, replay, delegation, privilege escalation and ambiguity.",
      "The rail is deterministic and fake. Effect counters describe simulations, never real captures or production volume. Mutation checks help establish that important boundaries are exercised.",
      "Run npm run evidence:check and inspect break-authority-integrated-1000.json. Review category distribution, controls and source revision. Independent reproduction and real-provider fault commissioning remain separate.",
    ],
  ],
];
companyDocuments.research = make(
  "Research",
  "Technical essays on financial Authority, not claims of standards participation.",
  [],
  researchArticles.map(([slug, title]) => [title, `/research/${slug}/`]),
);
for (const [slug, title, intro, paragraphs] of researchArticles)
  companyDocuments[`research/${slug}`] = make(
    title,
    intro,
    [{ title: "The boundary", paragraphs }],
    [
      ["Evidence", "/evidence/"],
      ["All research", "/research/"],
    ],
  );
