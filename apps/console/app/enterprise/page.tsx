const controls = [
  ["Organization", "Tenant and environment boundaries with scoped membership roles."],
  ["Authorities", "Organization-owned Authority plus reusable candidate templates."],
  ["Agents", "Inventory, human sponsors, lifecycle and external identity mapping."],
  ["Delegations", "Ancestry, monotonic attenuation and revocation propagation."],
  ["Approvals", "Separation of duties and authenticated multi-party approval evidence."],
  ["Reconciliation", "Operational queues for UNKNOWN outcomes without re-execution."],
  ["Integrations", "ERP, procurement and AP connector contracts around the same kernel."],
  ["Audit / Proof", "Durable evidence, privacy controls and exportable financial truth."],
] as const;

export default function EnterprisePage() {
  return (
    <>
      <p className="label">Enterprise control plane</p>
      <h1 className="h1">Let agents execute financial work without surrendering control.</h1>
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
      <p className="note">
        Current environment is sandbox/developer preview. No enterprise customer,
        certification or production pilot is implied by this surface.
      </p>
    </>
  );
}
