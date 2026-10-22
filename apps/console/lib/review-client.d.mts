export type ClientReviewState = {
  status: string;
  source: string;
  review: null | {
    status: string;
    message: string;
    question: string | null;
    terms: { label: string; value: string }[];
    interpreted: { label: string; value: string }[];
    fingerprint: string | null;
    reasonCodes: string[];
    expiresAt: string;
  };
};
export function createReviewController(
  publish: (state: ClientReviewState) => void,
  transport?: (source: string, signal: AbortSignal) => Promise<unknown>,
  clock?: () => number,
): {
  getState: () => ClientReviewState;
  edit: (source: string) => void;
  expire: () => void;
  dispose: () => void;
  submit: (source: string) => Promise<void>;
};
