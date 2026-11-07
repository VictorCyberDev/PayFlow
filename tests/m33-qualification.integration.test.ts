import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";
import {
  CRITERIA,
  DEFAULT_REQUIRED,
  assess,
  verificationProblem,
  type EvidenceKind,
  type FactRow,
  type FactStatus,
} from "../src/missions/qualification.js";

/**
 * V3 M33 — supplier qualification, against the real Gateway on PostgreSQL. Qualified means the required evidence is on file and
 * current; only a person verifies; an agent can claim or report a failure but can never raise a supplier's standing or erase a
 * person's verification.
 */
const url = process.env.TEST_DATABASE_URL;
const NOW = "2026-10-23T10:00:00.000Z";
const ANY_ONLY = {
  merchantRestrictions: { mode: "ONLY" as const, ids: ["acme"] },
};
const fact = (
  criterion: string,
  status: FactStatus,
  evidenceKind: EvidenceKind,
  daysAgo = 0,
  actorKind: "MEMBER" | "AGENT" = "MEMBER",
): FactRow => ({
  criterion,
  status,
  evidenceKind,
  evidenceRef:
    evidenceKind === "OWNER_ATTESTATION" || evidenceKind === "NONE"
      ? null
      : "ref",
  recordedAt: new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString(),
  actorKind,
});
const table = (...fs: FactRow[]) => new Map(fs.map((f) => [f.criterion, f]));
const good = [
  fact("IDENTITY", "VERIFIED", "OWNER_ATTESTATION"),
  fact("PAYMENT_ACCEPTED", "VERIFIED", "CONNECTOR_CALL"),
  fact("RETURN_POLICY", "VERIFIED", "DOCUMENT_REF"),
];

describe("M33 qualification rules (pure)", () => {
  it("only a person verifies, with evidence acceptable for the criterion and a reference where one is needed", () => {
    expect(
      verificationProblem("IDENTITY", "OWNER_ATTESTATION", null, "AGENT"),
    ).toBe("ONLY_A_PERSON_CAN_VERIFY");
    expect(
      verificationProblem("IDENTITY", "OWNER_ATTESTATION", null, "MEMBER"),
    ).toBeNull();
    expect(
      verificationProblem("IDENTITY", "CONNECTOR_CALL", "cal_x", "MEMBER"),
    ).toMatch(/^EVIDENCE_NOT_ACCEPTABLE/u);
    expect(
      verificationProblem("IDENTITY", "DOCUMENT_REF", null, "MEMBER"),
    ).toBe("EVIDENCE_REFERENCE_REQUIRED");
    expect(verificationProblem("NOPE", "DOCUMENT_REF", "x", "MEMBER")).toBe(
      "UNKNOWN_CRITERION",
    );
    // PayFlow does not screen sanctions: only a person's attestation that their own screening was done counts
    for (const k of ["CONNECTOR_CALL", "DOCUMENT_REF", "NONE"] as const)
      expect(
        verificationProblem("SANCTIONS_SCREEN", k, "x", "MEMBER"),
        k,
      ).toMatch(/^EVIDENCE_NOT_ACCEPTABLE/u);
    expect(
      verificationProblem(
        "SANCTIONS_SCREEN",
        "OWNER_ATTESTATION",
        null,
        "MEMBER",
      ),
    ).toBeNull();
    expect(
      CRITERIA.every((c) => c.validDays > 0 && c.acceptableEvidence.length > 0),
    ).toBe(true);
  });

  it("assessment: nothing is met by silence, a claim or an expired verification; one failure disqualifies; all verified qualifies", () => {
    const run = (
      fs: FactRow[],
      contractLike: Parameters<typeof assess>[2] = ANY_ONLY,
      ref = "acme",
      required: readonly string[] = DEFAULT_REQUIRED,
      now = NOW,
    ) => assess(required, table(...fs), contractLike, ref, now);
    expect(run([]).outcome).toBe("INCOMPLETE");
    expect(run(good).outcome).toBe("QUALIFIED");
    expect(
      run([...good, fact("IDENTITY", "CLAIMED", "NONE", 0, "AGENT")]).outcome,
    ).toBe("INCOMPLETE");
    expect(
      run([...good, fact("RETURN_POLICY", "FAILED", "NONE")]).outcome,
    ).toBe("NOT_QUALIFIED");
    expect(
      run([...good, fact("RETURN_POLICY", "UNKNOWN", "NONE")]).outcome,
    ).toBe("INCOMPLETE");
    // contract: not on the ONLY list, or no merchant allowed -> disqualified whatever the evidence says; ANY -> allowed
    expect(run(good, ANY_ONLY, "other").outcome).toBe("NOT_QUALIFIED");
    expect(
      run(good, { merchantRestrictions: { mode: "NONE_ALLOWED" } }).outcome,
    ).toBe("NOT_QUALIFIED");
    expect(
      run(good, { merchantRestrictions: { mode: "ANY" } }, "whoever").outcome,
    ).toBe("QUALIFIED");
    // expiry is per criterion: payment (90 days) lapses before identity (365)
    const aged = run(
      good.map((f) => ({
        ...f,
        recordedAt: new Date(Date.parse(NOW) - 100 * 86_400_000).toISOString(),
      })),
    );
    expect(aged.outcome).toBe("INCOMPLETE");
    expect(
      aged.criteria
        .filter((c) => c.expired)
        .map((c) => c.criterion)
        .sort(),
    ).toEqual(["PAYMENT_ACCEPTED", "RETURN_POLICY"]);
    expect(aged.criteria.find((c) => c.criterion === "IDENTITY")!.state).toBe(
      "SATISFIED",
    );
    // defence in depth: a row that says VERIFIED with evidence not acceptable for the criterion does not count
    expect(
      run([
        ...good.filter((f) => f.criterion !== "IDENTITY"),
        fact("IDENTITY", "VERIFIED", "CONNECTOR_CALL"),
      ]).outcome,
    ).toBe("INCOMPLETE");
    // an empty requirement list never qualifies anyone
    expect(run(good, ANY_ONLY, "acme", []).outcome).toBe("INCOMPLETE");
    // an unknown criterion in a policy is open, never met
    expect(
      run(good, ANY_ONLY, "acme", [...DEFAULT_REQUIRED, "MADE_UP"]).outcome,
    ).toBe("INCOMPLETE");
  });

  it("property: QUALIFIED happens exactly when every required criterion has a current, acceptable, person-verified fact and the contract allows it", () => {
    let seed = 99;
    const rnd = (n: number) =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const statuses: FactStatus[] = ["CLAIMED", "VERIFIED", "FAILED", "UNKNOWN"];
    const kinds: EvidenceKind[] = [
      "NONE",
      "CONNECTOR_CALL",
      "DOCUMENT_REF",
      "OWNER_ATTESTATION",
    ];
    const ids = CRITERIA.map((c) => c.id);
    for (let i = 0; i < 600; i++) {
      const required = ["CONTRACT_ALLOWED", ...ids.filter(() => rnd(3) === 0)];
      const fs = ids
        .filter(() => rnd(4) !== 0)
        .map((id) => fact(id, statuses[rnd(4)]!, kinds[rnd(4)]!, rnd(400)));
      const ref = rnd(2) === 0 ? "acme" : "stranger";
      const r = assess(required, table(...fs), ANY_ONLY, ref, NOW);
      const oracle = required.every((id) => {
        if (id === "CONTRACT_ALLOWED") return ref === "acme";
        const f = fs.find((x) => x.criterion === id);
        const def = CRITERIA.find((c) => c.id === id)!;
        return (
          !!f &&
          f.status === "VERIFIED" &&
          def.acceptableEvidence.includes(f.evidenceKind) &&
          (Date.parse(NOW) - Date.parse(f.recordedAt)) / 86_400_000 <=
            def.validDays
        );
      });
      expect(
        r.outcome === "QUALIFIED",
        JSON.stringify({ required, fs, ref }),
      ).toBe(oracle);
      if (r.outcome === "NOT_QUALIFIED")
        expect(r.criteria.some((c) => c.state === "FAILED")).toBe(true);
    }
  });
});

(url ? describe : describe.skip)(
  "M33 supplier qualification (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls,mission_candidates,mission_candidate_marks,mission_suppliers,mission_supplier_facts,mission_qualification_policy",
    });
    const MERCHANT = "payflow.demo.merchant";
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const ack = { acknowledgedDataUse: true };
    const mission = () =>
      activeMission(
        h,
        contract({
          approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
          expiresAt: "2027-03-01T00:00:00.000Z",
          agents: [
            {
              agentId: "a",
              capabilities: ["SEARCH", "READ", "COMPARE", "VERIFY"],
            },
            { agentId: "b", capabilities: ["READ"] },
            { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
          ],
        }),
      );
    type Assess = {
      required: string[];
      suppliers: {
        supplierId: string;
        externalRef: string;
        outcome: string;
        criteria: { criterion: string; state: string; expired: boolean }[];
      }[];
      notice: string;
    };
    const dossier = async (
      t: string,
      id: string,
      base = "/v1/admin/org/missions",
    ) =>
      (await (
        await h.call(t, "GET", `${base}/${id}/suppliers`)
      ).json()) as Assess;
    const addSupplier = async (
      t: string,
      id: string,
      body: unknown = { externalRef: MERCHANT, displayName: "Demo merchant" },
      base = "/v1/admin/org/missions",
    ) => post(t, `${base}/${id}/suppliers`, body);
    const supplierId = async (r: Response) =>
      ((await r.json()) as { supplierId: string }).supplierId;
    const record = (
      t: string,
      sid: string,
      body: Record<string, unknown>,
      base = "/v1/admin/org/suppliers",
    ) =>
      post(t, `${base}/${sid}/facts`, {
        value: {},
        idempotencyKey: idemKey("f"),
        ...body,
      });
    const reason = async (r: Response) =>
      (await r.json()) as { reason: string; detail?: string };
    /** A real, successful connector call in this mission, to cite as evidence. */
    const realCall = async (owner: string, a: string, id: string) => {
      await post(
        owner,
        "/v1/admin/org/connectors/payflow-demo-catalog/install",
        ack,
      );
      const r = await post(a, `/v1/agent/missions/${id}/connectors/invoke`, {
        connectorId: "payflow-demo-catalog",
        capability: "SEARCH",
        query: { text: "keyboard" },
        idempotencyKey: idemKey("c"),
      });
      return ((await r.json()) as { callId: string }).callId;
    };
    const qualify = async (
      owner: string,
      a: string,
      id: string,
      sid: string,
    ) => {
      const call = await realCall(owner, a, id);
      expect(
        (
          await record(owner, sid, {
            criterion: "IDENTITY",
            status: "VERIFIED",
            evidenceKind: "OWNER_ATTESTATION",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await record(owner, sid, {
            criterion: "PAYMENT_ACCEPTED",
            status: "VERIFIED",
            evidenceKind: "CONNECTOR_CALL",
            evidenceRef: call,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await record(owner, sid, {
            criterion: "RETURN_POLICY",
            status: "VERIFIED",
            evidenceKind: "DOCUMENT_REF",
            evidenceRef: "https://acme.example/returns",
          })
        ).status,
      ).toBe(201);
      return call;
    };

    it("suppliers are added by a person or an agent that can READ, idempotently, from a merchant a candidate states; tenants are separate", async () => {
      const { owner, a, b, c, id } = await mission();
      const first = await addSupplier(owner, id);
      expect(first.status).toBe(201);
      const sid = await supplierId(first);
      const again = await addSupplier(
        a,
        id,
        { externalRef: MERCHANT },
        "/v1/agent/missions",
      );
      expect(again.status).toBe(200);
      expect(await supplierId(again)).toBe(sid);
      expect(
        (
          await addSupplier(
            b,
            id,
            { externalRef: "other.merchant" },
            "/v1/agent/missions",
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await addSupplier(
            c,
            id,
            { externalRef: "third.merchant" },
            "/v1/agent/missions",
          )
        ).status,
      ).toBe(403);
      // both ways or neither way of naming the supplier is refused; bad ids are refused
      expect(
        (
          await addSupplier(owner, id, {
            externalRef: MERCHANT,
            fromCandidateId: `cnd_${"a".repeat(24)}`,
          })
        ).status,
      ).toBe(400);
      expect((await addSupplier(owner, id, {})).status).toBe(400);
      expect(
        (await addSupplier(owner, id, { externalRef: "bad ref!" })).status,
      ).toBe(400);
      // from a candidate: its merchantId claim names the supplier; a candidate that states none cannot
      await post(
        owner,
        "/v1/admin/org/connectors/payflow-demo-catalog/install",
        ack,
      );
      const found = (await (
        await post(a, `/v1/agent/missions/${id}/discovery/search`, {
          connectorId: "payflow-demo-catalog",
          query: { text: "keyboard" },
          idempotencyKey: idemKey("s"),
        })
      ).json()) as { candidates: { candidateId: string }[] };
      const viaCandidate = await addSupplier(owner, id, {
        fromCandidateId: found.candidates[0]!.candidateId,
      });
      expect([viaCandidate.status, await supplierId(viaCandidate)]).toEqual([
        200,
        sid,
      ]);
      await h.repo
        .sql`update mission_candidates set claims = '{}'::jsonb where false`; // (candidates are immutable; this documents the intent)
      // another organization sees nothing
      const stranger = await h.ownerOf("org-other");
      expect(
        (
          await h.call(
            stranger,
            "GET",
            `/v1/admin/org/missions/${id}/suppliers`,
          )
        ).status,
      ).toBe(404);
      expect((await addSupplier(stranger, id)).status).toBe(404);
      expect(
        (
          await record(stranger, sid, {
            criterion: "IDENTITY",
            status: "CLAIMED",
          })
        ).status,
      ).toBe(404);
    });

    it("an agent can claim or report a failure but can never verify, attest or erase a verification; a person can; the history keeps everything", async () => {
      const { owner, a, b, id } = await mission();
      const sid = await supplierId(await addSupplier(owner, id));
      const agent = (body: Record<string, unknown>) =>
        record(a, sid, body, "/v1/agent/suppliers");
      expect(
        (
          await agent({
            criterion: "IDENTITY",
            status: "CLAIMED",
            note: "site says registered in DE",
          })
        ).status,
      ).toBe(201);
      let r = await agent({
        criterion: "IDENTITY",
        status: "VERIFIED",
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "x",
      });
      expect([r.status, (await reason(r)).detail]).toEqual([
        403,
        "ONLY_A_PERSON_CAN_VERIFY",
      ]);
      r = await agent({
        criterion: "IDENTITY",
        status: "CLAIMED",
        evidenceKind: "OWNER_ATTESTATION",
      });
      expect([r.status, (await reason(r)).detail]).toEqual([
        403,
        "ATTESTATION_IS_A_PERSONS_ACT",
      ]);
      expect(
        (
          await record(
            b,
            sid,
            { criterion: "IDENTITY", status: "CLAIMED" },
            "/v1/agent/suppliers",
          )
        ).status,
      ).toBe(403); // b has no VERIFY grant
      expect(
        (await agent({ criterion: "MADE_UP", status: "CLAIMED" })).status,
      ).toBe(400);
      expect(
        (await agent({ criterion: "CONTRACT_ALLOWED", status: "CLAIMED" }))
          .status,
      ).toBe(400); // computed, not recorded
      expect(
        (
          await agent({
            criterion: "IDENTITY",
            status: "CLAIMED",
            evidenceKind: "DOCUMENT_REF",
          })
        ).status,
      ).toBe(400); // reference required
      expect(
        (
          await agent({
            criterion: "IDENTITY",
            status: "CLAIMED",
            evidenceRef: "x",
          })
        ).status,
      ).toBe(400); // reference without a kind
      // evidence must be a real successful call of this mission
      r = await agent({
        criterion: "PAYMENT_ACCEPTED",
        status: "CLAIMED",
        evidenceKind: "CONNECTOR_CALL",
        evidenceRef: "cal_" + "0".repeat(24),
      });
      expect([r.status, (await reason(r)).detail]).toEqual([
        400,
        "NO_SUCH_SUCCESSFUL_CONNECTOR_CALL_FOR_THIS_MISSION",
      ]);
      const other = await mission(); // another mission, same organization
      const foreignCall = await realCall(other.owner, other.a, other.id);
      r = await agent({
        criterion: "PAYMENT_ACCEPTED",
        status: "CLAIMED",
        evidenceKind: "CONNECTOR_CALL",
        evidenceRef: foreignCall,
      });
      expect(r.status).toBe(400);
      // a person verifies; a weaker agent fact cannot erase it, a reported failure can and fails the supplier
      expect(
        (
          await record(owner, sid, {
            criterion: "IDENTITY",
            status: "VERIFIED",
            evidenceKind: "OWNER_ATTESTATION",
          })
        ).status,
      ).toBe(201);
      r = await agent({ criterion: "IDENTITY", status: "CLAIMED" });
      expect(r.status).toBe(403);
      expect(
        (await agent({ criterion: "IDENTITY", status: "UNKNOWN" })).status,
      ).toBe(403);
      const state = async () =>
        (await dossier(owner, id)).suppliers.find((s) => s.supplierId === sid)!;
      expect(
        (await state()).criteria.find((c) => c.criterion === "IDENTITY")!.state,
      ).toBe("SATISFIED");
      expect(
        (
          await agent({
            criterion: "IDENTITY",
            status: "FAILED",
            note: "registry shows dissolved",
          })
        ).status,
      ).toBe(201);
      expect((await state()).outcome).toBe("NOT_QUALIFIED");
      expect(
        (
          await record(owner, sid, {
            criterion: "IDENTITY",
            status: "VERIFIED",
            evidenceKind: "DOCUMENT_REF",
            evidenceRef: "registry extract 2026-10-23, entity active",
          })
        ).status,
      ).toBe(201);
      expect(
        (await state()).criteria.find((c) => c.criterion === "IDENTITY")!.state,
      ).toBe("SATISFIED");
      const hist = (await (
        await h.call(owner, "GET", `/v1/admin/org/suppliers/${sid}/facts`)
      ).json()) as {
        facts: { criterion: string; status: string; by: string }[];
      };
      expect(hist.facts.map((f) => f.status)).toEqual([
        "CLAIMED",
        "VERIFIED",
        "FAILED",
        "VERIFIED",
      ]);
      expect(hist.facts[0]!.by).toMatch(/^agent:/u);
      await expect(
        h.repo
          .sql`update mission_supplier_facts set status = 'VERIFIED' where supplier_id = ${sid}`,
      ).rejects.toThrow();
      await expect(
        h.repo
          .sql`delete from mission_supplier_facts where supplier_id = ${sid}`,
      ).rejects.toThrow();
      await expect(
        h.repo.sql`delete from mission_suppliers where supplier_id = ${sid}`,
      ).rejects.toThrow();
    });

    it("a supplier becomes QUALIFIED only with every required criterion verified on acceptable evidence; wrong evidence kinds are refused", async () => {
      const { owner, a, id } = await mission();
      const sid = await supplierId(await addSupplier(owner, id));
      const state = async () => (await dossier(owner, id)).suppliers[0]!;
      let s = await state();
      expect(s.outcome).toBe("INCOMPLETE");
      expect((await dossier(owner, id)).required).toEqual([
        ...DEFAULT_REQUIRED,
      ]);
      expect((await dossier(owner, id)).notice).toContain("not an approval");
      expect(
        s.criteria.find((c) => c.criterion === "CONTRACT_ALLOWED")!.state,
      ).toBe("SATISFIED");
      // a person cannot verify with the wrong kind of evidence
      let r = await record(owner, sid, {
        criterion: "IDENTITY",
        status: "VERIFIED",
        evidenceKind: "CONNECTOR_CALL",
        evidenceRef: "cal_x",
      });
      expect([r.status, (await reason(r)).detail]).toEqual([
        403,
        expect.stringContaining("EVIDENCE_NOT_ACCEPTABLE") as unknown as string,
      ]);
      r = await record(owner, sid, {
        criterion: "SANCTIONS_SCREEN",
        status: "VERIFIED",
        evidenceKind: "DOCUMENT_REF",
        evidenceRef: "report.pdf",
      });
      expect(r.status).toBe(403);
      r = await record(owner, sid, {
        criterion: "RETURN_POLICY",
        status: "VERIFIED",
        evidenceKind: "DOCUMENT_REF",
      });
      expect(r.status).toBe(400);
      await qualify(owner, a, id, sid);
      s = await state();
      expect(s.outcome).toBe("QUALIFIED");
      // the same view for an agent that can READ
      expect(
        (await dossier(a, id, "/v1/agent/missions")).suppliers[0]!.outcome,
      ).toBe("QUALIFIED");
      // raising the bar changes the outcome: sanctions screening is required and only an attestation closes it
      const dev = await h.member("DEVELOPER");
      const policy = (t: string, required: string[]) =>
        post(t, `/v1/admin/org/missions/${id}/qualification-policy`, {
          required,
          idempotencyKey: idemKey("p"),
        });
      expect((await policy(dev, ["IDENTITY"])).status).toBe(403);
      expect((await policy(a, ["IDENTITY"])).status).toBe(401);
      expect((await policy(owner, ["MADE_UP"])).status).toBe(400);
      expect((await policy(owner, [])).status).toBe(400);
      expect((await policy(owner, ["IDENTITY", "IDENTITY"])).status).toBe(400);
      const raised = (await (
        await policy(owner, [...DEFAULT_REQUIRED.slice(1), "SANCTIONS_SCREEN"])
      ).json()) as { required: string[] };
      expect(raised.required[0]).toBe("CONTRACT_ALLOWED");
      expect((await state()).outcome).toBe("INCOMPLETE");
      expect(
        (
          await record(owner, sid, {
            criterion: "SANCTIONS_SCREEN",
            status: "VERIFIED",
            evidenceKind: "OWNER_ATTESTATION",
            note: "our screening run 2026-10-23",
          })
        ).status,
      ).toBe(201);
      expect((await state()).outcome).toBe("QUALIFIED");
      // a policy cannot drop what the contract allows
      const lowered = (await (await policy(owner, ["IDENTITY"])).json()) as {
        required: string[];
      };
      expect(lowered.required).toEqual(["CONTRACT_ALLOWED", "IDENTITY"]);
    });

    it("the contract decides first: a supplier the contract does not allow is NOT_QUALIFIED whatever the evidence says", async () => {
      const { owner, a, id } = await mission();
      const sid = await supplierId(
        await addSupplier(owner, id, { externalRef: "not.in.contract" }),
      );
      await qualify(owner, a, id, sid);
      const s = (await dossier(owner, id)).suppliers[0]!;
      expect(s.outcome).toBe("NOT_QUALIFIED");
      expect(
        s.criteria.find((c) => c.criterion === "CONTRACT_ALLOWED")!.state,
      ).toBe("FAILED");
    });

    it("verifications expire per criterion as time passes", async () => {
      const { owner, a, id } = await mission();
      const sid = await supplierId(await addSupplier(owner, id));
      await qualify(owner, a, id, sid);
      expect((await dossier(owner, id)).suppliers[0]!.outcome).toBe(
        "QUALIFIED",
      );
      h.advance(91 * 86_400_000);
      // The first owner's key has expired with the clock: a new owner reads the same dossier.
      const minted = await h.call(ADMIN_TOKEN, "POST", "/v1/admin/members", {
        organizationId: "payflow-sandbox",
        environment: "SANDBOX",
        displayName: "owner later",
        role: "OWNER",
      });
      const fresh = ((await minted.json()) as { token: string }).token;
      const s = (await dossier(fresh, id)).suppliers[0]!;
      expect(s.outcome).toBe("INCOMPLETE");
      expect(
        s.criteria
          .filter((c) => c.expired)
          .map((c) => c.criterion)
          .sort(),
      ).toEqual(["PAYMENT_ACCEPTED", "RETURN_POLICY"]);
      expect(s.criteria.find((c) => c.criterion === "IDENTITY")!.state).toBe(
        "SATISFIED",
      );
    });

    it("idempotency, pause and permission gates hold", async () => {
      const { owner, a, id } = await mission();
      const sid = await supplierId(await addSupplier(owner, id));
      const key = idemKey("same");
      const body = {
        criterion: "IDENTITY",
        status: "CLAIMED",
        note: "n",
        idempotencyKey: key,
      };
      expect(
        (
          (await (
            await record(a, sid, body, "/v1/agent/suppliers")
          ).json()) as { replayed: boolean }
        ).replayed,
      ).toBe(false);
      expect(
        (
          (await (
            await record(a, sid, body, "/v1/agent/suppliers")
          ).json()) as { replayed: boolean }
        ).replayed,
      ).toBe(true);
      expect(
        (
          await record(
            a,
            sid,
            { ...body, status: "FAILED" },
            "/v1/agent/suppliers",
          )
        ).status,
      ).toBe(409);
      const rows = await h.repo
        .sql`select count(*)::int as n from mission_supplier_facts where supplier_id = ${sid}`;
      expect(rows[0]!.n).toBe(1);
      const dev = await h.member("DEVELOPER");
      expect(
        (await record(dev, sid, { criterion: "IDENTITY", status: "CLAIMED" }))
          .status,
      ).toBe(403);
      expect(
        (await h.call(dev, "GET", `/v1/admin/org/missions/${id}/suppliers`))
          .status,
      ).toBe(200);
      expect(
        (await post(owner, "/v1/admin/org/pause", { reason: "t" })).status,
      ).toBe(200);
      expect(
        (
          await record(
            a,
            sid,
            { criterion: "IDENTITY", status: "CLAIMED" },
            "/v1/agent/suppliers",
          )
        ).status,
      ).toBe(423);
      await post(owner, "/v1/admin/org/resume", {});
      await post(owner, `${MISSIONS}/${id}/pause`, { reason: "t" });
      expect(
        (
          await record(
            a,
            sid,
            { criterion: "IDENTITY", status: "CLAIMED" },
            "/v1/agent/suppliers",
          )
        ).status,
      ).toBe(403);
    });
  },
);
