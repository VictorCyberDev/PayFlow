/**
 * Where "Sign in" goes. The customer application (the `/workspace/` app served by the hosting/m6 function) is not publicly open yet, so until the
 * owner commissions it this is null and the header links to the honest private-preview page instead of a demo console that cannot sign anyone in.
 * To open it, set this to the application's address (for example "https://app.example.com/workspace/") and nothing else needs to change.
 */
export const CUSTOMER_APP_URL: string | null = null;
export const SIGN_IN_HREF = CUSTOMER_APP_URL ?? "/preview/";
