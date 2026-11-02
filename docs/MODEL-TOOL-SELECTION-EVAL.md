# Model tool-selection evaluation

Status: **COMPLETE_LOCAL** for the reference selector and evaluation capability. No live-model results exist. M19's complete provider journeys remain PARTIAL.

| Evaluator                        | Evidence                                     | Prompts | Precision / recall / FPR / wrong tool / arguments         | Live status      |
| -------------------------------- | -------------------------------------------- | ------: | --------------------------------------------------------- | ---------------- |
| Deterministic reference selector | docs/evidence/tool-selection-eval.json       |      14 | Artifact records exact selection cases; not a model score | COMPLETE_LOCAL   |
| OpenAI                           | Recorded HTTP response/tool-result loop only |  0 live | Not measured                                              | BLOCKED_EXTERNAL |
| Claude                           | Recorded Messages loop only                  |  0 live | Not measured                                              | BLOCKED_EXTERNAL |
| Gemini                           | Recorded function-call loop only             |  0 live | Not measured                                              | BLOCKED_EXTERNAL |

`src/protocols/model-eval.ts` contains 37 prompts across positive, negative, ambiguous, financial education, merchant verification, Proof, execution, reconciliation, revocation, procurement/enterprise, indirect requests, injection and widening. The evaluator refuses incomplete/duplicate observations. Metrics are provider-specific. No cross-provider average is defined.

`node --import tsx scripts/run-model-eval.ts` requires explicit provider/model/key and opt-in. It makes at most three provider requests per prompt. It does not retry requests. No call was made: no OpenAI/Anthropic/Gemini keys or confirmed free quota were available in the workspace. A ChatGPT subscription is not treated as an API key or free API budget.

Tool precision counts exact correct tool selections among selected calls. Recall counts exact correct tool selections among expected calls. False-positive rate counts calls on negative/clarification cases. Wrong-tool rate counts a selected different tool on positive cases. Argument correctness remains null without adjudication. Read-only mutation attempts and verification/execution confusion are separate counts. Clarification text detection in the runner is a disclosed heuristic requiring case review. Missing results are never scored as passes.

The dataset's referenced actions/presentations must be supplied as synthetic fixtures for a full argument-correctness study. This runner currently establishes selection-evaluation capability; it does not establish an accepted end-to-end provider benchmark.
