import { createServer } from "node:http";
/** Local HTTP bridge for protocol clients and tests. Bind to loopback only. */
export function createProtocolHttpServer(
  handler: (request: Request) => Promise<Response>,
) {
  return createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += Buffer.byteLength(chunk as Buffer);
        if (size > 65536) {
          outgoing.writeHead(413);
          outgoing.end();
          return;
        }
        chunks.push(Buffer.from(chunk as Buffer));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const method = incoming.method ?? "GET";
      const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
        method,
        headers,
        ...(method !== "GET" && method !== "HEAD"
          ? { body: Buffer.concat(chunks) }
          : {}),
      });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      outgoing.writeHead(500);
      outgoing.end();
    });
  });
}
