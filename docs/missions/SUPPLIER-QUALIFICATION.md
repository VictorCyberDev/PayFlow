# Supplier qualification (V3 M33)

Before a mission deals with a supplier, there is a dossier: a history of facts about named criteria, and a computed answer: **QUALIFIED**, **NOT_QUALIFIED** or **INCOMPLETE**.

> Qualified means the required evidence is on file and current. It is **not** an approval to negotiate, buy or contract, and PayFlow does **not** itself screen suppliers (identity, sanctions, reputation). A person does that and records that they did.

## Who can say what

|                                             | Agent (with `VERIFY`)                                | Person (`mission:plan`)                          |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| Claim a fact, mark it unknown               | yes                                                  | yes                                              |
| Report a failure                            | yes (it only ever makes a supplier _less_ qualified) | yes                                              |
| Mark a fact **VERIFIED**                    | **never**                                            | yes, with evidence acceptable for that criterion |
| Attest ("I checked")                        | **never**                                            | yes                                              |
| Weaken a person's verification with a claim | **refused** (`WOULD_ERASE_A_VERIFICATION`)           | a newer person's fact wins                       |

Facts are append-only; the latest per criterion is current and the whole history is kept (the database refuses edits and deletes).

## Criteria and acceptable evidence

`IDENTITY` (attestation or document), `PAYMENT_ACCEPTED` (reviewed connector observation or attestation), `RETURN_POLICY` and `WARRANTY` (connector observation or document), `SHIPS_TO_REGION`, `REFERENCES`, and `SANCTIONS_SCREEN` (**attestation only**: it records that the person's own screening was done). A connector observation counts only as a reference to a real, successful call of **this** mission; one that does not exist, or belongs to another mission, is refused.

`CONTRACT_ALLOWED` is computed, never recorded: the contract's merchant list (`ONLY` / `ANY` / `NONE_ALLOWED`) is checked first and cannot be dropped from the required set. A supplier the contract does not allow is NOT_QUALIFIED whatever the evidence says.

## Satisfied, failed, open

A criterion is satisfied only by a VERIFIED fact with acceptable evidence that is still current (each criterion has a validity: 30 to 365 days). A FAILED fact fails the supplier. Everything else (nothing recorded, a claim, an unknown, an expired verification) leaves the criterion **open**, and open is never counted as met. Default required set: contract check, identity, payment accepted, return policy; a person can raise it.

## Status

COMPLETE_LOCAL. Later milestones (negotiation, purchase) are expected to require QUALIFIED through `QualificationService.isQualified`; that enforcement lands in those milestones, not here. Migration 036 pending on the public database. 9 tests (3 pure including a 600-case property check against an independent oracle, 6 on real PostgreSQL/HTTP); 11 mutation checks each fail a test.
