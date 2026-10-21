import postgres from "postgres";
import {
  PostgresPaymentStatusReader,
  payerReturnResponse,
  type PaymentStatusReader,
} from "../src/payer-return.js";

let reader: PaymentStatusReader | undefined;

export function GET(request: Request): Promise<Response> {
  const databaseUrl = process.env.PAYFLOW_STATUS_DATABASE_URL;
  if (!reader && databaseUrl) {
    try {
      reader = new PostgresPaymentStatusReader(
        postgres(databaseUrl, {
          max: 2,
          connect_timeout: 3,
          idle_timeout: 20,
          prepare: false,
        }),
      );
    } catch {
      console.error("PAYFLOW_STATUS_STORE_CONFIGURATION_INVALID");
    }
  }
  return payerReturnResponse(
    request,
    reader ?? {
      find: () => Promise.reject(new Error("STATUS_STORE_UNCONFIGURED")),
    },
  );
}
