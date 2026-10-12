import { z } from "zod";
import {
  OperationTraceSchema,
  type OperationTraceService,
} from "./operation-trace.js";
import { AdversarialResultSchema } from "./adversarial-projection.js";
export const DemoProjectionSchema = z
  .object({
    version: z.literal("payflow.m4-demo.v1"),
    trustTrace: OperationTraceSchema,
    adversarialResult: AdversarialResultSchema.optional(),
  })
  .strict();
/** The projection always obtains verification from trusted durable reads. */
export async function projectM4Demo(
  service: OperationTraceService,
  query: unknown,
  now: string,
  attack?: unknown,
) {
  const trustTrace = await service.project(query, now);
  const result = DemoProjectionSchema.parse({
    version: "payflow.m4-demo.v1",
    trustTrace,
    ...(attack === undefined ? {} : { adversarialResult: attack }),
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw new Error("DEMO_PROJECTION_LIMIT_EXCEEDED");
  return result;
}
