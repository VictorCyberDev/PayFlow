export const OPT_IN_VARIABLE: string;
export function assertDisposableDatabase(
  rawUrl: string,
  env?: Record<string, string | undefined>,
): { host: string; database: string };
export function assertScratchName(name: string): string;
