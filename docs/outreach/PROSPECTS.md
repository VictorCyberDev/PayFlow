# M25 — Prospect research (2026-11-06)

Status: **research complete for four prospects; no outreach has been sent; no replies, pilots or integrations exist.**
Everything below is from public pages read on 2026-11-06 (links given). Nothing was inferred about individuals; no personal
contact details were collected. These companies are _adjacent_ to PayFlow and in places competitors; each entry says so.

PayFlow's honest position today: a **sandbox** (simulated rail, plus a PayPal sandbox path) with a deterministic
pre-execution Authority, portable signed Proof with a first-class UNKNOWN outcome, MCP and A2A interfaces, framework
adapters, hosted Proof verification and an offline-verifiable credential format. No production rail, no certification, no
uptime commitment, no customers. The public deployment is not yet live.

## Why anyone would care (evidence, not hype)

- Practitioners describe the missing piece as "standardized agent identity and capability declarations -- something like 'this agent is
  authorized by user X to spend up to $Y on category Z'" ([Ask HN thread, anecdotal](https://news.ycombinator.com/item?id=47371289)).
- Card/wallet vendors already ship spend limits: virtual cards with limits and MCC restrictions
  ([Nevermined's comparison](https://nevermined.ai/blog/virtual-card-platforms-ai-agents),
  [Privacy](https://agents.privacy.com/), [Crossmint](https://www.crossmint.com/learn/agent-card-payments-compared)).
  A spend limit on a card is not a decision about _this_ purchase, a record of what happened, or a way for a merchant to
  check it. That is the narrow gap PayFlow claims: decide before money moves, prove afterwards, and say UNKNOWN when unknown.

## Prospects

### 1. Crossmint — agent wallets and agent virtual cards

- **What they do:** "fiat and stablecoin wallets purpose-built for AI agents", virtual Visa/Mastercard numbers for agents
  with "scoped permissions and guardrails" ([source](https://www.crossmint.com/learn/agent-card-payments-compared)).
- **Fit:** PayFlow could sit in front of their issuance as the per-request decision and Proof layer.
- **Risk:** their guardrails overlap; they may see PayFlow as a feature, not a partner.
- **Verified route:** public partnership form, "Fill out this form and our partnership team will get back to you"
  ([crossmint.com/partners](https://www.crossmint.com/partners)).

### 2. Tipalti — AP automation with an "AP Agent"

- **What they do:** "AP Agent runs your accounts payable workflows through review and approval, with you in control"
  ([source](https://tipalti.com/ap-automation/)).
- **Fit:** a bounded-authority and Proof layer for agent-initiated payables; their approval step is the human-in-the-loop
  PayFlow's ESCALATE maps to.
- **Risk:** large vendor, long partner cycles; PayFlow has no production rail to offer.
- **Verified route:** Technology Partner Program with a "Become a Partner" path
  ([tipalti.com/resources/technology-partners](https://tipalti.com/resources/technology-partners/)).

### 3. Marqeta — card issuing platform with an open-source MCP server

- **What they do:** an MCP server letting agents use Marqeta's payment APIs, with "spend and velocity controls" on virtual
  cards; open source at `github.com/marqeta/marqeta-mcp`; the docs mark it **Beta** and say to "contact your Marqeta
  representative" ([docs](https://www.marqeta.com/docs/developer-guides/agentic-ai-mcp-server)).
- **Fit:** the strongest technical match — same protocol (MCP), and a clear place for a pre-execution decision and a Proof.
- **Risk:** their program is customer-gated (representative); a cold approach may go nowhere.
- **Verified route:** "Talk with an expert" form ([marqeta.com/contact-us](https://www.marqeta.com/contact-us), linked
  from [their MCP page](https://www.marqeta.com/platform/mcp-server)).

### 4. Medius — spend management and AP automation

- **What they do:** AP automation expanding "from AP automation into procurement, payments, supplier workflows, and
  source-to-pay" with AI agents ([source](https://www.medius.com/blog/how-ai-agents-are-expanding-from-ap-automation-into-source-to-pay/)).
- **Fit:** an ISV integration that gives their agents a bounded, provable payment decision.
- **Risk:** their ISV programme ("Radius") is built around ERP integrations and co-sell; a sandbox-stage product may not qualify.
- **Verified route:** ISV/technology partner page ([medius.com/partners](https://www.medius.com/partners/)).

### Noted, not pursued yet

- **Privacy.com** ([agents.privacy.com](https://agents.privacy.com/)): agent virtual cards with a CLI and MCP URL. No partner
  route was verified, so no entry. **WaldenPay**, **Slash**, **Ramp**: card-based agent spend; competitors rather than partners.

## Outreach log

| Prospect  | Channel (verified)          | Draft         | Sent | Reply |
| --------- | --------------------------- | ------------- | ---- | ----- |
| Crossmint | web partnership form        | `DRAFTS.md` 1 | no   | none  |
| Tipalti   | web technology-partner form | `DRAFTS.md` 2 | no   | none  |
| Marqeta   | web contact form            | `DRAFTS.md` 3 | no   | none  |
| Medius    | web partner page / form     | `DRAFTS.md` 4 | no   | none  |

**Why nothing was sent:** every verified route is a public web form, which would be submitted in the owner's name and
cannot be recalled. No form was submitted and no email was sent from any connected account. Sending needs the owner to
approve the exact text and the sender identity. Replies, pilots and integrations are recorded here only when they
actually happen.
