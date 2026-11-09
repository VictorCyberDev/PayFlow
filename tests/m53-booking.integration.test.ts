/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import { TRUNCATE } from "./helpers/settled-order.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";

/**
 * V3 M53 — booking intents through the real Gateway on PostgreSQL. No provider is contacted: the person books outside PayFlow and records
 * evidence. What these tests pin: approval holds budget atomically; only evidence says "reserved"; UNKNOWN is resolved only by evidence;
 * budget is conserved and released exactly once; agents can propose but never decide.
 */
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "M53 booking intents (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        TRUNCATE +
        ",mission_booking_events,mission_bookings,mission_workspace_listings,mission_workspace_searches",
    });
    const post = (t: string, p: string, b: unknown = {}) =>
      h.call(t, "POST", p, b);
    const get = (t: string, p: string) => h.call(t, "GET", p);
    const body = async (r: Response) => (await r.json()) as Record<string, any>;
    const scene = () =>
      activeMission(
        h,
        contract({
          currency: "GBP",
          approvedProviderTypes: ["WORKSPACE_PROVIDER"],
          maxCommitmentMinor: 200_000,
          totalBudgetMinor: 300_000,
        }),
      );
    const searchReq = () => ({
      sourceId: "sandbox-workspaces",
      need: {
        country: "GB",
        city: "Bristol",
        kinds: ["PRIVATE_OFFICE", "DESK", "MEETING_ROOM"],
        minCapacity: 4,
        currency: "GBP",
        maxExposureMinor: 200_000,
        requiredAmenities: ["Wi-Fi"],
        maxMinTermDays: 14,
      },
      stay: {
        start: "2026-12-08T09:00:00.000Z",
        end: "2026-12-15T09:00:00.000Z",
        people: 4,
      },
      cancelAt: "2026-12-07T09:00:00.000Z",
      idempotencyKey: idemKey("w"),
    });
    const searched = async (s: Awaited<ReturnType<typeof scene>>) => {
      const r = await post(
        s.owner,
        `/v1/admin/org/missions/${s.id}/workspaces`,
        searchReq(),
      );
      return (await body(r)).search.searchId as string;
    };
    const propose = (
      t: string,
      mid: string,
      searchId: string,
      listingId: string,
      over: Record<string, unknown> = {},
      base = "/v1/admin/org",
    ) =>
      post(t, `${base}/missions/${mid}/bookings`, {
        searchId,
        listingId,
        deadline: "2026-11-20T10:00:00.000Z",
        idempotencyKey: idemKey("b"),
        ...over,
      });
    const act = (t: string, id: string, op: string, b: unknown = {}) =>
      post(t, `/v1/admin/org/bookings/${id}/${op}`, b);
    const exposure = async (s: { owner: string; id: string }) =>
      (await body(await get(s.owner, `${MISSIONS}/${s.id}/ledger`))).summary
        .exposureMinor as number;
    const stageOf = async (id: string) =>
      String(
        (
          await h.repo
            .sql`select i.stage from mission_ledger_items i join mission_bookings b on b.ledger_item_id = i.item_id where b.booking_id = ${id}`
        )[0]?.stage,
      );
    const made = async (
      s: Awaited<ReturnType<typeof scene>>,
      listing = "sbx-harbour-office",
    ) => {
      const sid = await searched(s);
      const r = await propose(s.owner, s.id, sid, listing);
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
      return { sid, id: (await body(r)).booking.bookingId as string };
    };

    it("the whole life: propose → approve (budget held) → hand-off → confirm with evidence (obligation recorded) → deposit → cancel with a charge", async () => {
      const s = await scene();
      const { id } = await made(s);
      expect(await exposure(s)).toBe(0); // proposing holds nothing
      const ap = await act(s.owner, id, "approve");
      expect(ap.status, JSON.stringify(await ap.clone().json())).toBe(200);
      const v = (await body(ap)).booking;
      expect(v).toMatchObject({
        state: "APPROVED",
        reserved: "NO",
        heldMinor: 136_500,
        deposit: "NOT_PAID",
      });
      expect(v.headline).toContain("Nothing is reserved yet");
      expect(await exposure(s)).toBe(136_500);
      expect(await stageOf(id)).toBe("APPROVED");
      const ho = await body(
        await act(s.owner, id, "handoff", { note: "Ringing them Monday" }),
      );
      expect(ho.booking.state).toBe("HANDED_OFF");
      expect(ho.packet).toMatchObject({
        expectedTotalMinor: 86_500,
        expectedDepositMinor: 50_000,
        currency: "GBP",
      });
      expect(ho.packet.doNot).toContain("Do not agree");
      expect(ho.booking.reserved).toBe("NO");
      // confirmation needs evidence; a bare request is refused and changes nothing
      expect(
        (
          await act(s.owner, id, "confirm", {
            evidenceKind: "PROVIDER_CONFIRMATION_REF",
          })
        ).status,
      ).toBe(400);
      const cf = await body(
        await act(s.owner, id, "confirm", {
          evidenceKind: "PROVIDER_CONFIRMATION_REF",
          evidenceRef: "HRB-2026-0042",
        }),
      );
      expect(cf.booking).toMatchObject({
        state: "CONFIRMED",
        reserved: "YES_PROVIDER_CONFIRMED",
      });
      expect(await stageOf(id)).toBe("COMMITTED");
      expect(await exposure(s)).toBe(136_500);
      // deposit: recorded only with evidence; attestation alone is "unconfirmed"
      expect(
        (await act(s.owner, id, "deposit", { evidenceKind: "DOCUMENT_REF" }))
          .status,
      ).toBe(400);
      const dp = await body(
        await act(s.owner, id, "deposit", {
          evidenceKind: "OWNER_ATTESTATION",
        }),
      );
      expect(dp.booking.deposit).toBe("PAID_UNCONFIRMED");
      expect(h.provider.createCalls + h.provider.captureCalls).toBe(0); // PayFlow moved nothing
      // cancel: the charge may not exceed the frozen terms; the hold is released except the charge
      expect(
        (await act(s.owner, id, "cancel", { penaltyMinor: 86_501 })).status,
      ).toBe(422);
      expect(await exposure(s)).toBe(136_500);
      const cn = await body(
        await act(s.owner, id, "cancel", {
          penaltyMinor: 10_000,
          note: "plans changed",
        }),
      );
      expect(cn.booking.state).toBe("CANCELLED");
      expect(await exposure(s)).toBe(10_000);
      const ev = await h.repo
        .sql`select to_state from mission_booking_events where booking_id = ${id} order by seq`;
      expect(ev.map((e) => e.to_state)).toEqual([
        "PROPOSED",
        "APPROVED",
        "HANDED_OFF",
        "CONFIRMED",
        "CANCELLED",
      ]);
      await expect(h.repo.sql`delete from mission_bookings`).rejects.toThrow(
        /append-only/,
      );
      await expect(
        h.repo
          .sql`update mission_bookings set frozen = '{}'::jsonb where booking_id = ${id}`,
      ).rejects.toThrow(/never change/);
    });

    it("only a listing that fits with every term stated can be proposed; one live intent per listing; agents propose but never decide", async () => {
      const s = await scene();
      const sid = await searched(s);
      const code = async (r: Response) => [r.status, (await body(r)).reason];
      // the unknown-everything office is refused, with the named problems
      const mill = await propose(s.owner, s.id, sid, "sbx-mill-office");
      expect(await code(mill.clone())).toEqual([422, "NOT_QUALIFIED"]);
      expect((await body(mill)).detail).toContain("EXPOSURE_UNKNOWN");
      expect(
        await code(await propose(s.owner, s.id, sid, "sbx-quay-room")),
      ).toEqual([422, "NOT_QUALIFIED"]); // above the exposure limit
      expect(await code(await propose(s.owner, s.id, sid, "nope"))).toEqual([
        404,
        "NOT_FOUND",
      ]);
      expect(
        await code(
          await propose(s.owner, s.id, sid, "sbx-harbour-office", {
            deadline: "2026-10-22T09:00:00.000Z",
          }),
        ),
      ).toEqual([422, "BAD_DEADLINE"]);
      expect(
        await code(
          await propose(s.owner, s.id, sid, "sbx-harbour-office", {
            deadline: "2027-02-01T00:00:00.000Z",
          }),
        ),
      ).toEqual([422, "BAD_DEADLINE"]);
      // an agent with REQUEST_APPROVAL (c) may propose; it can never approve, hand off, confirm, decline, cancel or record a deposit
      const k = idemKey("b");
      const byAgent = await propose(
        s.c,
        s.id,
        sid,
        "sbx-harbour-office",
        { idempotencyKey: k },
        "/v1/agent",
      );
      expect(byAgent.status).toBe(201);
      const id = (await body(byAgent)).booking.bookingId as string;
      expect(
        (
          await propose(
            s.c,
            s.id,
            sid,
            "sbx-harbour-office",
            { idempotencyKey: k },
            "/v1/agent",
          )
        ).status,
      ).toBe(200); // replay
      expect(
        await code(await propose(s.owner, s.id, sid, "sbx-harbour-office")),
      ).toEqual([409, "ALREADY_LIVE"]);
      for (const op of [
        "approve",
        "handoff",
        "unknown",
        "confirm",
        "decline",
        "cancel",
        "deposit",
      ]) {
        const r = await post(s.c, `/v1/agent/bookings/${id}/${op}`, {});
        expect([op, r.status, (await body(r)).reason]).toEqual([
          op,
          403,
          "MEMBER_ONLY",
        ]);
      }
      expect(
        (await propose(s.a, s.id, sid, "sbx-harbour-office", {}, "/v1/agent"))
          .status,
      ).toBe(403); // a research agent has no REQUEST_APPROVAL
      expect(await exposure(s)).toBe(0);
      const stranger = await h.ownerOf("org-other");
      expect((await act(stranger, id, "approve")).status).toBe(404);
    });

    it("UNKNOWN keeps the budget held and is resolved only by evidence; a refusal releases it exactly once", async () => {
      const s = await scene();
      const { id } = await made(s);
      await act(s.owner, id, "approve");
      await act(s.owner, id, "handoff");
      const u = await body(
        await act(s.owner, id, "unknown", { note: "call dropped" }),
      );
      expect(u.booking).toMatchObject({
        state: "UNKNOWN",
        reserved: "UNKNOWN",
      });
      expect(u.booking.headline).toContain("Don't book again");
      expect(await exposure(s)).toBe(136_500);
      // from UNKNOWN: declining needs evidence that it was NOT booked; the hold stays until then
      expect(
        (await act(s.owner, id, "decline", { note: "I think not" })).status,
      ).toBe(400);
      expect(await exposure(s)).toBe(136_500);
      const d = await body(
        await act(s.owner, id, "decline", {
          evidenceKind: "DOCUMENT_REF",
          evidenceRef: "provider-email-no-booking.pdf",
        }),
      );
      expect(d.booking.state).toBe("DECLINED");
      expect(await exposure(s)).toBe(0);
      // finished is finished, and replaying a decline is not a second release
      expect(
        (
          await act(s.owner, id, "confirm", {
            evidenceKind: "OWNER_ATTESTATION",
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await act(s.owner, id, "decline", {
            evidenceKind: "DOCUMENT_REF",
            evidenceRef: "x",
          })
        ).status,
      ).toBe(200);
      expect(await exposure(s)).toBe(0);
      // the owner's own word is labelled as such, never as provider-confirmed
      const second = await made(s, "sbx-harbour-office");
      const a2 = await act(s.owner, second.id, "approve");
      expect(a2.status, JSON.stringify(await a2.clone().json())).toBe(200);
      const h2 = await act(s.owner, second.id, "handoff");
      expect(h2.status, JSON.stringify(await h2.clone().json())).toBe(200);
      const attRes = await act(s.owner, second.id, "confirm", {
        evidenceKind: "OWNER_ATTESTATION",
      });
      expect(attRes.status, JSON.stringify(await attRes.clone().json())).toBe(
        200,
      );
      const att = await body(attRes);
      expect(att.booking).toMatchObject({
        state: "CONFIRMED",
        reserved: "OWNER_SAYS_SO",
      });
      expect(att.booking.headline).toContain("no proof");
    });

    it("approval is atomic and conserved: five simultaneous approvals hold the budget once; over-budget approval is refused and leaves nothing", async () => {
      const s = await scene();
      const { id } = await made(s);
      const rs = await Promise.all(
        Array.from({ length: 5 }, () => act(s.owner, id, "approve")),
      );
      for (const r of rs) expect([200, 409]).toContain(r.status);
      expect(
        Number(
          (
            await h.repo
              .sql`select count(*)::int n from mission_ledger_items where mission_id = ${s.id} and kind = 'SERVICE'`
          )[0]!.n,
        ),
      ).toBe(1);
      expect(await exposure(s)).toBe(136_500);
      // a mission whose budget cannot hold it: the approval is refused and no ledger item, state change or event survives
      const tight = await activeMission(
        h,
        contract({
          currency: "GBP",
          approvedProviderTypes: ["WORKSPACE_PROVIDER"],
          maxCommitmentMinor: 200_000,
          totalBudgetMinor: 200_000,
        }),
      );
      const t = await made(tight);
      await post(tight.owner, `${MISSIONS}/${tight.id}/ledger/items`, {
        kind: "GOODS",
        label: "x",
        amountMinor: 100_000,
        currency: "GBP",
        stage: "COMMITTED",
        verification: "OWNER_REPORTED",
        evidenceKind: "OWNER_REPORTED",
        idempotencyKey: idemKey("l"),
      });
      const over = await act(tight.owner, t.id, "approve");
      expect([over.status, (await body(over)).reason]).toEqual([
        409,
        "LEDGER_REFUSED",
      ]);
      expect(
        Number(
          (
            await h.repo
              .sql`select count(*)::int n from mission_ledger_items where mission_id = ${tight.id} and kind = 'SERVICE'`
          )[0]!.n,
        ),
      ).toBe(0);
      expect(
        String(
          (
            await h.repo
              .sql`select state from mission_bookings where booking_id = ${t.id}`
          )[0]!.state,
        ),
      ).toBe("PROPOSED");
    });

    it("a crash inside approval or confirmation leaves neither a held budget nor a half state; an unconfirmed intent expires and releases", async () => {
      const s = await scene();
      const { id } = await made(s);
      await h.repo.sql.unsafe(
        `create or replace function r0_booking_failpoint() returns trigger language plpgsql as $f$ begin raise exception 'FAILPOINT_BOOKING'; end $f$`,
      );
      await h.repo.sql.unsafe(
        `create trigger r0_booking_failpoint before update on mission_bookings for each row when (new.state = 'APPROVED') execute function r0_booking_failpoint()`,
      );
      let crashed: Response;
      try {
        crashed = await act(s.owner, id, "approve");
      } finally {
        await h.repo.sql.unsafe(
          `drop trigger if exists r0_booking_failpoint on mission_bookings`,
        );
      }
      expect(crashed.status).toBeGreaterThanOrEqual(500);
      expect(await exposure(s)).toBe(0);
      expect(
        String(
          (
            await h.repo
              .sql`select state from mission_bookings where booking_id = ${id}`
          )[0]!.state,
        ),
      ).toBe("PROPOSED");
      expect((await act(s.owner, id, "approve")).status).toBe(200); // the retry completes it once
      expect(await exposure(s)).toBe(136_500);
      // past its deadline without confirmation: expires and releases (read triggers the sweep)
      h.advance(29 * 86_400_000);
      const list = await body(
        await get(s.owner, `/v1/admin/org/missions/${s.id}/bookings`),
      );
      expect(list.bookings[0].state).toBe("EXPIRED");
      expect(await exposure(s)).toBe(0);
    });
  },
);
