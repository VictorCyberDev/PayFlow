export class ExecutionQuarantinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionQuarantinedError";
  }
}
