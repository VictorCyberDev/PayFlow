const surfaces = [
  ["Gateway", "Submit an exact action to deterministic Authority evaluation."],
  [
    "REST API",
    "Versioned requests, scoped access, stable error taxonomy and idempotency.",
  ],
  [
    "TypeScript SDK",
    "Small client surface without server secrets in browser state.",
  ],
  [
    "Python SDK",
    "Dependency-light API access for server-side agents and services.",
  ],
  ["MCP", "Five financial-authority tools with read/execution separation."],
  [
    "A2A",
    "Agent Card plus authenticated, attenuating agent-to-agent delegation.",
  ],
  [
    "Proof verifier",
    "Standalone verification without access to money-moving APIs.",
  ],
  ["Sandbox", "Deterministic rails, fixtures, faults and reconciliation."],
] as const;

export default function DeveloperPage() {
  return (
    <>
      <p className="label">Developer platform</p>
      <h1 className="h1">
        Give an agent capability without unrestricted power.
      </h1>
      <p className="lead">
        Integrate once at the financial-authority boundary. Protocols and rails
        remain replaceable; the Trust Kernel remains authoritative.
      </p>
      <div className="surface-grid">
        {surfaces.map(([name, description]) => (
          <article className="surface-card" key={name}>
            <h2 className="h3">{name}</h2>
            <p>{description}</p>
          </article>
        ))}
      </div>
      <section className="block">
        <p className="label">Five-minute conceptual path</p>
        <ol className="plain">
          <li>Create a sandbox principal or organization.</li>
          <li>Register an Agent and create bounded Authority.</li>
          <li>Call Gateway with the exact proposed action.</li>
          <li>Receive ALLOW, DENY or ESCALATE — never model permission.</li>
          <li>Execute only with the bounded grant, then verify Proof.</li>
        </ol>
      </section>
      <p className="outcome-line">Any agent. Any rail. One authority truth.</p>
    </>
  );
}
