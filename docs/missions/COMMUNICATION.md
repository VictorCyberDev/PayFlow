# Supplier communication (V3 M37)

Talking to suppliers, under control.

## Rules

- **Recipients are registered by a person.** A contact is a plain email address a person registers for a supplier and says how they know it is theirs. An agent cannot type an address. Header-injection forms (line breaks, lists, display names) are refused. A contact can be **blocked** by security (`mission:contain`) at once; only a finance admin or owner restores it.
- **Every outbound message waits for a person.** Drafting (by an agent with `DRAFT`, or `NEGOTIATE` for a counteroffer; or by a person) only creates a message in `PENDING_APPROVAL`; nothing is sent. A person with `mission:communicate` approves or rejects it. An approved message can still be rejected before it is sent.
- **Negotiation messages carry a structured counteroffer** (`move`) that must pass the M36 rules: walk-away, term floors, rounds, concessions, disclosure, a named negotiator, a supplier still qualified, a budget that can still afford it. Accepting by message is not possible here; it is a later, separately governed step.
- **Agent-written text is scanned** for the exact amounts it was told to keep (the budget, the largest commitment, the approval threshold, what is left, every walk-away and target) in the usual ways of writing them, and for other suppliers' references and names. The offered amount may be stated. It is a tripwire, not a judge of meaning: it can over-block, and it cannot catch a paraphrase, which is why a person approves every message too. A person's own words are not scanned; they choose what to say.
- **Checked three times.** At draft, at approval and again at the moment of sending: the mission is running, the contact is not blocked, and the negotiation rules (if any) still allow the move. A change in between stops the message before the channel is touched, and the message stays `APPROVED` so it can go once the cause is gone.
- **Exactly once.** Sending claims the message (`APPROVED → SENDING`) under a lock, so concurrent sends reach the channel once, and the message id is passed to the provider as its idempotency key. Asking again returns the current status and never sends again.
- **Uncertainty is recorded, not guessed.** A channel returns a reference (`SENT`), throws a definite error only when it is certain nothing was sent (`FAILED`), and anything else (timeout, dropped connection) is `DELIVERY_UNKNOWN`. PayFlow **never retries** it; a person checks with the supplier or the provider and resolves it as `SENT` or `FAILED` with a note.
- **Replies are untrusted.** A person records what a supplier wrote; it is stored verbatim, labelled `UNTRUSTED_SUPPLIER_TEXT`, and causes nothing (no send, approval, ledger entry or Authority).
- **Content never changes.** The database refuses edits to a message's content or recipient and any deletion; only the status moves, one legal step at a time, each step an event.

## Channels

One ships: the **sandbox** email channel, which sends nothing anywhere and is refused in PRODUCTION. A live provider needs the owner to choose it and supply its credential; that is a code change and review, never configuration. **No live channel exists today (BLOCKED_EXTERNAL).**

## Status

COMPLETE_LOCAL against the sandbox channel and scripted test channels. Migration 040 pending on the public database. 11 tests (3 pure including the exact status machine and the leak scan, 8 on real PostgreSQL/HTTP); 23 mutation checks each fail a test. Nothing in this milestone sends a real message.
