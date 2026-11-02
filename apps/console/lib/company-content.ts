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
    "Developer preview. No independent audit, certification, standards membership or production uptime is claimed.",
    [
      {
        title: "Financial invariants",
        paragraphs: [
          "Models cannot authorize themselves. Credentials do not grant Authority. Execution requires an exact action, reservation and one-time grant. Revoked or expired Authority blocks fresh dispatch.",
          "UNKNOWN is a first-class outcome. An API error does not establish $0 moved. Reconciliation looks up the original attempt without creating another effect.",
        ],
      },
      {
        title: "Authentication and isolation",
        paragraphs: [
          "Hosted console sessions bind principal identity server-side. Tenant-scoped adapters and integration tests exercise cross-tenant refusal. Protocol access must bind verified subject, audience and scopes to server-owned services.",
          "OAuth JWT verification uses fixed issuer/JWKS/audience configuration. End-user OAuth and public protocol deployment remain pending. Local tokens are not a production login system.",
        ],
      },
      {
        title: "Encryption, secrets and Proof",
        paragraphs: [
          "M6 encrypts delegated instrument and bootstrap records using AES-256-GCM. Signing keys and provider credentials remain server-side. Protocol output filtering supplements explicit result projection; it is not a general data-loss prevention guarantee.",
          "Signatures establish who signed a statement and whether it changed. Issuer trust, provider evidence and reconciliation remain necessary to establish financial meaning.",
        ],
      },
      {
        title: "Retention and operations",
        paragraphs: [
          "Privacy modules preserve immutable financial evidence through deletion workflows. Production schedules, legal basis and deletion processes need legal and operational review.",
          "For an incident: restrict fresh dispatch, preserve evidence, reconcile outstanding attempts and state what is known. Dependency scans and adversarial tests do not replace an independent audit.",
        ],
      },
      {
        title: "Responsible disclosure",
        paragraphs: [
          "Choose Security on the contact page to request a private channel. Do not post exploit details, personal data or secrets in public issues. No response-time SLA or bounty payment is promised.",
          "Managed intake, incident rota, operational monitoring and an independent audit remain pending.",
        ],
      },
    ],
    [
      ["Security inquiry", "/contact/"],
      ["Evidence", "/evidence/"],
      ["Data disclosure", "/subprocessors/"],
    ],
  ),
  status: make(
    "Service status",
    "Operational monitoring is not commissioned. These are declared states, not live health checks or measured uptime.",
    [
      {
        title: "API · Gateway · Verify",
        paragraphs: [
          "M7–M60 local implementation. No company release deployed by this session. Availability is not asserted.",
        ],
      },
      {
        title: "Console · Sandbox",
        paragraphs: [
          "Historical acceptance deployments exist independently. Public illustrations use local data and contact no provider.",
        ],
      },
      {
        title: "External dependencies",
        paragraphs: [
          "M6 PayPal delegated acceptance and OpenAI/Claude/Gemini commissioning remain pending. No external provider health is inferred.",
        ],
      },
      {
        title: "Before operational launch",
        paragraphs: [
          "Configure authenticated probes, component ownership, incident updates and an observation window. Publish uptime only after measurement.",
        ],
      },
    ],
  ),
  pricing: make(
    "Start with a boundary.",
    "Free Sandbox evaluation. Commercial prices are not validated; no paid checkout or automatic subscription is enabled.",
    [
      {
        title: "Developer / Free Sandbox",
        paragraphs: [
          "Local fixtures, deterministic rails, SDKs, protocol tools and test evidence. No real money.",
        ],
      },
      {
        title: "Platform / Subscription + governed actions",
        paragraphs: [
          "Intended commercial model. Rates, included usage and terms require a confirmed offer. Metering infrastructure is not revenue validation.",
        ],
      },
      {
        title: "Enterprise / Custom",
        paragraphs: [
          "Discuss identity, procurement controls, integration support, retention and security evaluation. No certification or delivery SLA is implied.",
        ],
      },
      {
        title: "Verify / Low-friction evaluation",
        paragraphs: [
          "Portable local verification is available in source. Hosted quotas and pricing follow commissioning.",
        ],
      },
    ],
    [
      ["Discuss your use case", "/contact/"],
      ["Start building", "/docs/quickstart/"],
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
    "Engineering history, not a commercial release timeline.",
    [
      {
        title: "2026-10-28 / Integration candidate",
        paragraphs: [
          "Source head 6bcab82 includes Gateway, Verify, SDKs, enterprise modules, reconciliation, portable verification and local adversarial artifacts. External publication remains pending.",
        ],
      },
      {
        title: "2026-10-29 / Company work in progress",
        paragraphs: [
          "Company/app separation, corrected milestone classifications and protocol transport/tool-use corrections. This describes source work, not production release.",
        ],
      },
    ],
    [
      [
        "Commit history",
        "https://github.com/VictorCyberDev/PayFlow/commits/m7-m60-master-execution/",
      ],
    ],
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
    "Explore an interactive local illustration. It does not execute payments or contact a provider.",
    [
      {
        title: "Continue in the console",
        paragraphs: [
          "The authenticated console needs a configured backend and access code. A signed-out preview is not a customer account. The quickstart reproduces a local governed path.",
        ],
      },
    ],
    [
      ["Console preview", "/app/"],
      ["Quickstart", "/docs/quickstart/"],
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
    "Local quickstart",
    "Reproduce the kernel and local Sandbox without deploying or making a paid model call.",
    [
      {
        title: "Install and verify",
        paragraphs: [
          "Use Node 22+ and Python 3. PostgreSQL is required for durable integration suites. Live provider suites are opt-in.",
        ],
        code: "git clone https://github.com/VictorCyberDev/PayFlow.git\ncd PayFlow\ngit checkout m7-m60-master-execution\nnpm ci\nnpm run typecheck\nnpm test\nnpm run evidence:check\npython3 -m unittest discover -s packages/sdk-python/tests -v",
      },
      {
        title: "Examples and console",
        paragraphs: [
          "The procurement example exercises local Authority. Vendor loops are in examples/model-tool-flow.ts. HTTP commissioning is in docs/PROTOCOL-COMMISSIONING.md. These are repository paths, not hosted APIs.",
        ],
        code: "npx tsx examples/procurement-ap-agent.ts\nnpm run build\ncd apps/console\nnpm ci\nnpm run build",
      },
    ],
  ),
  "docs/api": make(
    "API & error reference",
    "Canonical schema: openapi/payflow-v1.yaml. Implementation: src/network/rest.ts. No hosted endpoint is implied.",
    [
      {
        title: "Requests",
        paragraphs: [
          "Send the exact action and stable nonce/replay identity. Bind agent, principal, audience and scopes from trusted authentication, never model arguments.",
          "ALLOW is not captured. DENY blocks execution. ESCALATE requires approval. Provider timeouts remain UNKNOWN.",
        ],
      },
      {
        title: "Errors",
        paragraphs: [
          "ACCESS_MALFORMED, ACCESS_INACTIVE, ACCESS_EXPIRED, ACCESS_WRONG_AUDIENCE and ACCESS_SCOPE_DENIED fail closed. MCP_INVALID_ARGUMENTS and MCP_SCOPE_DENIED refuse invalid tool calls.",
          "401: authenticate. 403: denied. 409: replay/conflict. 429: bounded backoff for safe reads. Never retry a financial write with a new identity after timeout.",
        ],
      },
    ],
    [
      [
        "OpenAPI source",
        "https://github.com/VictorCyberDev/PayFlow/blob/m7-m60-master-execution/openapi/payflow-v1.yaml",
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
        "https://github.com/VictorCyberDev/PayFlow/tree/m7-m60-master-execution/packages",
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
        title: "Authority",
        paragraphs: [
          "Check signature, trusted issuer, audience, challenge, expiry and revocation. Verification dependencies must expose no money-moving capability.",
        ],
      },
      {
        title: "Proof",
        paragraphs: [
          "Inspect Authority, agent, exact action, Gate, rail, outcome, reconciliation and validation. Headline outcomes follow provider evidence, never network exceptions.",
          "Review identifiers before sharing. Safe public sharing and retention require deployment-specific review.",
        ],
      },
    ],
    [
      [
        "Verifier source",
        "https://github.com/VictorCyberDev/PayFlow/tree/m7-m60-master-execution/packages/verifier",
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
        title: "Scopes",
        paragraphs: [
          "authority:read → check_financial_authority. action:request → request_authorized_action. verify:read → verify_authority. proof:read → verify_financial_proof. reconcile:request → reconcile_financial_action.",
          "Bind subject, principal, audience, lifecycle and expiry server-side. Reject wrong issuer, audience, signature or scope. Arguments cannot authenticate the model.",
        ],
      },
      {
        title: "Deployment",
        paragraphs: [
          "Configure fixed trusted issuer/JWKS values. For end-user ChatGPT use authorization code + S256 PKCE and exact resource binding. Do not publish metadata pointing to an unconfigured issuer.",
          "High-entropy local tokens are isolated commissioning credentials, not an end-user identity service.",
        ],
      },
    ],
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
