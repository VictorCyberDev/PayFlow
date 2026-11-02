const controls = [
  [
    "Organization",
    "Tenant and environment boundaries with scoped membership roles.",
  ],
  [
    "Authorities",
    "Organization-owned Authority plus reusable candidate templates.",
  ],
  [
    "Agents",
    "Inventory, human sponsors, lifecycle and external identity mapping.",
  ],
  [
    "Delegations",
    "Ancestry, monotonic attenuation and revocation propagation.",
  ],
  [
    "Approvals",
    "Separation of duties and authenticated multi-party approval evidence.",
  ],
  [
    "Reconciliation",
    "Operational queues for UNKNOWN outcomes without re-execution.",
  ],
  [
    "Integrations",
    "ERP, procurement and AP connector contracts around the same kernel.",
  ],
  [
    "Audit / Proof",
    "Durable evidence, privacy controls and exportable financial truth.",
  ],
] as const;

import { AgentTable } from "../ui/orgviews";

const sample = [
  {
    agent: "Procurement Agent",
    sponsor: "finance-owner",
    lifecycle: "ACTIVE",
    activeAuthorities: 2,
    exposureMinor: 50000,
    blastRadiusMinor: 682000,
    downstream: 1,
    deniedLast24h: 3,
    lastDecision: "12 min ago",
  },
  {
    agent: "Research Agent",
    sponsor: "ops-owner",
    lifecycle: "SUSPENDED",
    activeAuthorities: 0,
    exposureMinor: 0,
    blastRadiusMinor: 0,
    downstream: 0,
    deniedLast24h: 0,
    lastDecision: "2 days ago",
  },
];

export default function EnterprisePage() {
  return (
    <>
      <p className="label">Enterprise control plane</p>
      <h1 className="h1">
        Let agents execute financial work without surrendering control.
      </h1>
      <p className="lead">
        Enterprise governance sits above the same Authority kernel used by every
        agent, verifier, protocol and rail. Organization controls can narrow or
        require approval; they cannot bypass the Gate.
      </p>
      <div className="surface-grid">
        {controls.map(([name, description]) => (
          <article className="surface-card" key={name}>
            <h2 className="h3">{name}</h2>
            <p>{description}</p>
          </article>
        ))}
      </div>
      <section aria-labelledby="homes" className="block">
        <h2 id="homes" className="h2">
          One truth, four lenses
        </h2>
        <ul>
          <li>
            <strong>Finance:</strong> reserved, in flight, settled and available
            exposure per Authority and in total, with pending approvals.
          </li>
          <li>
            <strong>Security:</strong> for each agent, its sponsor, what it
            could still commit if compromised, who it delegates to and recent
            denials, with suspend and revoke.
          </li>
          <li>
            <strong>Developer:</strong> credentials, request outcomes and Proof.
          </li>
          <li>
            <strong>Admin:</strong> members, agents, sponsors, environment and
            an append-only audit of who created, changed, revoked, approved and
            issued credentials.
          </li>
        </ul>
        <AgentTable rows={sample} illustrative />
        <p className="note">
          Built and tested in source behind an administrator route (tenant and
          environment isolated, audit enforced by the database). Not deployed.
          There is no sign-in console for these views yet, the member role model
          is not enforced in the preview (one administrator secret), and the
          rows above are illustrative.
        </p>
      </section>
      <p className="note">
        Current environment is sandbox/developer preview. No enterprise
        customer, certification or production pilot is implied by this surface.
      </p>
    </>
  );
}
