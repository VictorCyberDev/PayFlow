# Talent sources and candidates (M47)

- **Sources only observe.** A source is a read-only search over some marketplace or list. It cannot message, hire or pay. What it returns is
  untrusted: the whole result is bounded (at most 20 records, 64 KB), each record is parsed **strictly** (unknown fields, over-long text,
  malformed currency or rates, duplicate handles are dropped and counted, never repaired), and the source runs under a 5 second deadline
  with no database connection held. A failing source is reported as `SOURCE_FAILED` without its message.
- **What ships.** One source, `payflow-sandbox-talent`: six **fictional** profiles, every headline labelled so. It is refused in
  PRODUCTION. One of them carries an instruction in its headline on purpose; it is stored as plain data and nothing reads it as a command.
  **Live marketplaces are not provided**: they need the owner's credentials (BLOCKED_EXTERNAL). A source that requires a credential is never
  used without one.
- **A candidate is a claim.** It is an immutable snapshot of what the source or candidate said, imported for one role of the scope in
  force (a scope must be in force and the role must exist). Profiles in another currency than the scope's are skipped. The same snapshot
  is stored once per role and source. An agent needs SEARCH to import or add; anyone may add a candidate by hand (`MANUAL_ENTRY`).
- **Nothing is verified here.** Identity, portfolio and references are a person's checks (M49). Importing contacts no one.
