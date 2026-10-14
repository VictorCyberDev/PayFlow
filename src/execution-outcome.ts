export class ExecutionQuarantinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionQuarantinedError";
  }
}

/** Only a sink that proves no external side effect may use this classification. */
export class ExecutionRejectedError extends Error {}

export const PAYPAL_DEFINITIVE_CREATE_REJECTION =
  "PAYPAL_DEFINITIVE_CREATE_REJECTION";
