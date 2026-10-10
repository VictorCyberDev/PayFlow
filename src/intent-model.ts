import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  compileIntentDraft,
  IntentCompileContextSchema,
  IntentInterpretationSchema,
  type IntentCompileContext,
  type IntentCompileResult,
} from "./intent.js";
import {
  semanticIntentIssues,
  clarificationQuestions,
} from "./intent-semantics.js";
import { parseIntentJson } from "./intent-json.js";
import {
  INTENT_MODEL_INSTRUCTION,
  INTENT_MODEL_JSON_SCHEMA,
  INTENT_INSTRUCTION_VERSION,
} from "./intent-model-schema.js";

export const INTENT_MODEL_LIMITS = Object.freeze({
  sourceCharacters: 2000,
  sourceBytes: 4000,
  outputBytes: 32768,
  responseBytes: 65536,
  outputTokens: 2048,
  timeoutMs: 15000,
  calls: 1,
  retries: 0,
});
export const GROQ_INTENT_MODEL = "openai/gpt-oss-20b";
export type IntentModelFailure =
  | "MODEL_UNAVAILABLE"
  | "MODEL_RATE_LIMITED"
  | "MODEL_CONFIGURATION_ERROR"
  | "MODEL_REJECTED"
  | "INVALID_MODEL_OUTPUT"
  | "MODEL_TIMEOUT"
  | "MODEL_CANCELLED"
  | "INVALID_INTENT_INPUT";
export type IntentModelResponse =
  | { status: "INTERPRETED"; candidate: unknown }
  | { status: IntentModelFailure };
export interface IntentModelProvider {
  interpretIntent(
    source: Readonly<IntentCompileContext["source"]>,
    signal?: AbortSignal,
  ): Promise<IntentModelResponse>;
}
export type IntentProcessingResult =
  | {
      status: "INTERPRETED";
      compilation: IntentCompileResult;
      questions: readonly string[];
      diagnostic: { instructionVersion: string };
    }
  | { status: IntentModelFailure };
function validSource(source: IntentCompileContext["source"]): boolean {
  return (
    source.text.length > 0 &&
    source.text.length <= INTENT_MODEL_LIMITS.sourceCharacters &&
    Buffer.byteLength(source.text) <= INTENT_MODEL_LIMITS.sourceBytes &&
    source.reference.length > 0 &&
    source.reference.length <= 200
  );
}
/** Provider gets only source, never independent bounds, credentials or authority. */
export async function interpretIntent(
  provider: IntentModelProvider,
  rawContext: unknown,
  signal?: AbortSignal,
): Promise<IntentProcessingResult> {
  const parsed = IntentCompileContextSchema.safeParse(rawContext);
  if (!parsed.success || !validSource(parsed.data.source))
    return { status: "INVALID_INTENT_INPUT" };
  // Parsed copy prevents caller mutation during the network await from changing bounds.
  const context = parsed.data;
  Object.freeze(context.source);
  if (signal?.aborted) return { status: "MODEL_CANCELLED" };
  let response: IntentModelResponse;
  try {
    response = await provider.interpretIntent(context.source, signal);
  } catch {
    return { status: "MODEL_UNAVAILABLE" };
  }
  if (signal?.aborted) return { status: "MODEL_CANCELLED" };
  if (response.status !== "INTERPRETED") return { status: response.status };
  const candidate = IntentInterpretationSchema.safeParse(response.candidate);
  if (!candidate.success) return { status: "INVALID_MODEL_OUTPUT" };
  let compilation = compileIntentDraft(candidate.data, context);
  if (compilation.status !== "REJECTED") {
    const issues = semanticIntentIssues(candidate.data, context.source.text);
    if (issues.length)
      compilation = {
        status: "NEEDS_CLARIFICATION",
        issues: [
          ...new Set([
            ...(compilation.status === "NEEDS_CLARIFICATION"
              ? compilation.issues
              : []),
            ...issues,
          ]),
        ].sort(),
        interpretation: candidate.data,
      };
  }
  return {
    status: "INTERPRETED",
    compilation,
    questions:
      compilation.status === "NEEDS_CLARIFICATION"
        ? clarificationQuestions(compilation.issues)
        : [],
    diagnostic: { instructionVersion: INTENT_INSTRUCTION_VERSION },
  };
}
export class FakeIntentModelProvider implements IntentModelProvider {
  constructor(private readonly candidate: unknown) {}
  interpretIntent(): Promise<IntentModelResponse> {
    return Promise.resolve({
      status: "INTERPRETED",
      candidate: this.candidate,
    });
  }
}
const envelope = z
  .object({
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string(),
            message: z
              .object({
                role: z.literal("assistant"),
                content: z.string().nullable(),
                refusal: z.string().nullable().optional(),
                tool_calls: z.array(z.unknown()).optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough();
export class GroqIntentModelProvider implements IntentModelProvider {
  #key: string;
  #configured: boolean;
  constructor(
    config: { apiKey?: string; model?: string; provider?: string },
    private readonly transport: typeof fetch = fetch,
  ) {
    this.#key = config.apiKey ?? "";
    this.#configured =
      this.#key.trim().length > 0 &&
      !/[\r\n]/.test(this.#key) &&
      (config.model ?? GROQ_INTENT_MODEL) === GROQ_INTENT_MODEL &&
      (config.provider ?? "groq") === "groq";
  }
  static fromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): GroqIntentModelProvider {
    return new GroqIntentModelProvider({
      apiKey: env.GROQ_API_KEY ?? "",
      model: env.INTENT_MODEL_NAME ?? GROQ_INTENT_MODEL,
      provider: env.INTENT_MODEL_PROVIDER ?? "groq",
    });
  }
  async interpretIntent(
    source: Readonly<IntentCompileContext["source"]>,
    signal?: AbortSignal,
  ): Promise<IntentModelResponse> {
    if (!this.#configured) return { status: "MODEL_CONFIGURATION_ERROR" };
    if (!validSource(source)) return { status: "INVALID_INTENT_INPUT" };
    if (signal?.aborted) return { status: "MODEL_CANCELLED" };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    // Race also bounds faulty/custom transports that ignore abort.
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<IntentModelResponse>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ status: "MODEL_TIMEOUT" });
      }, INTENT_MODEL_LIMITS.timeoutMs);
    });
    const cancelled = new Promise<IntentModelResponse>((resolve) =>
      controller.signal.addEventListener(
        "abort",
        () =>
          resolve({ status: timedOut ? "MODEL_TIMEOUT" : "MODEL_CANCELLED" }),
        { once: true },
      ),
    );
    try {
      return await Promise.race([
        this.request(source, controller.signal),
        deadline,
        cancelled,
      ]);
    } catch {
      return {
        status: timedOut
          ? "MODEL_TIMEOUT"
          : signal?.aborted
            ? "MODEL_CANCELLED"
            : "MODEL_UNAVAILABLE",
      };
    } finally {
      clearTimeout(timer!);
      signal?.removeEventListener("abort", cancel);
    }
  }
  private async request(
    source: Readonly<IntentCompileContext["source"]>,
    signal: AbortSignal,
  ): Promise<IntentModelResponse> {
    const response = await this.transport(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${this.#key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_INTENT_MODEL,
          messages: [
            { role: "system", content: INTENT_MODEL_INSTRUCTION },
            {
              role: "user",
              content: JSON.stringify({
                sourceReference: source.reference,
                text: source.text,
              }),
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "payflow_intent_v1",
              strict: true,
              schema: INTENT_MODEL_JSON_SCHEMA,
            },
          },
          max_completion_tokens: INTENT_MODEL_LIMITS.outputTokens,
          temperature: 0,
          stream: false,
          n: 1,
          include_reasoning: false,
          reasoning_effort: "low",
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status:
          response.status === 429
            ? "MODEL_RATE_LIMITED"
            : [401, 403].includes(response.status)
              ? "MODEL_CONFIGURATION_ERROR"
              : response.status >= 500
                ? "MODEL_UNAVAILABLE"
                : "MODEL_REJECTED",
      };
    }
    if (
      !response.headers.get("content-type")?.includes("application/json") ||
      !response.body
    ) {
      await response.body?.cancel();
      return { status: "INVALID_MODEL_OUTPUT" };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > INTENT_MODEL_LIMITS.responseBytes) {
          await reader.cancel();
          return { status: "INVALID_MODEL_OUTPUT" };
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      const result = envelope.safeParse(
        parseIntentJson(Buffer.concat(chunks).toString("utf8")),
      );
      if (!result.success) return { status: "INVALID_MODEL_OUTPUT" };
      const choice = result.data.choices[0]!;
      if (choice.message.refusal || choice.finish_reason === "content_filter")
        return { status: "MODEL_REJECTED" };
      if (
        choice.finish_reason !== "stop" ||
        choice.message.tool_calls?.length ||
        !choice.message.content ||
        Buffer.byteLength(choice.message.content) >
          INTENT_MODEL_LIMITS.outputBytes
      )
        return { status: "INVALID_MODEL_OUTPUT" };
      const candidate = IntentInterpretationSchema.safeParse(
        parseIntentJson(choice.message.content),
      );
      return candidate.success
        ? { status: "INTERPRETED", candidate: candidate.data }
        : { status: "INVALID_MODEL_OUTPUT" };
    } catch {
      return { status: "INVALID_MODEL_OUTPUT" };
    }
  }
}
