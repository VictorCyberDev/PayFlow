export interface PayFlowClientOptions {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class PayFlowClient {
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly options: PayFlowClientOptions) {
    this.request = options.fetch ?? globalThis.fetch;
  }

  async readAuthority(authorityId: string): Promise<unknown> {
    return this.json(`/v1/authorities/${encodeURIComponent(authorityId)}`, {
      method: "GET",
    });
  }

  async requestAuthorizedAction(action: unknown): Promise<unknown> {
    return this.json("/v1/actions", {
      method: "POST",
      body: JSON.stringify(action),
    });
  }

  private async json(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(new URL(path, this.options.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const error = new Error(`PayFlow API request failed with ${response.status}`);
      Object.assign(error, { status: response.status, body });
      throw error;
    }
    return body;
  }
}
