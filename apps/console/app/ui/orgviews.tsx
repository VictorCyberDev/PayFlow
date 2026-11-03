import { usd } from "../../lib/money";

export interface AgentRowView {
  agent: string;
  sponsor: string;
  lifecycle: string;
  activeAuthorities: number;
  exposureMinor: number;
  blastRadiusMinor: number;
  downstream: number;
  deniedLast24h: number;
  lastDecision: string;
}

/** Same fields as GET /v1/admin/org/agents and /security. Rows passed in are labelled illustrative. */
export function AgentTable({
  rows,
  illustrative,
}: {
  rows: AgentRowView[];
  illustrative?: boolean;
}) {
  return (
    // A wide table scrolls sideways on a phone. The wrapper is a labelled, focusable region so a
    // keyboard user can scroll it, and the table keeps its native table semantics.
    <div
      className="org-table-wrap"
      role="region"
      aria-label="Agents table, scrolls sideways on narrow screens"
      tabIndex={0}
    >
      <table className="org-table">
        <caption>
          Agents, their sponsors and what each could still commit{" "}
          {illustrative ? "(illustrative data)" : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Sponsor</th>
            <th scope="col">State</th>
            <th scope="col">Active Authorities</th>
            <th scope="col">Exposure now</th>
            <th scope="col">If compromised, up to</th>
            <th scope="col">Delegates to</th>
            <th scope="col">Denied (24h)</th>
            <th scope="col">Last decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agent}>
              <th scope="row">{r.agent}</th>
              <td>{r.sponsor}</td>
              <td>{r.lifecycle}</td>
              <td>{r.activeAuthorities}</td>
              <td>{usd(r.exposureMinor)}</td>
              <td>{usd(r.blastRadiusMinor)}</td>
              <td>{r.downstream}</td>
              <td>{r.deniedLast24h}</td>
              <td>{r.lastDecision}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
