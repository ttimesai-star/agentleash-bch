// node:http adapter for LeashPaywall. Body limit 64 KiB.
import { createServer, type Server } from 'node:http';
import type { LeashPaywall } from './x402.js';

export function servePaywall(paywall: LeashPaywall, port: number, host = '127.0.0.1'): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 65_536) { res.writeHead(413).end('body too large'); return; }
        chunks.push(c as Buffer);
      }
      const url = new URL(req.url ?? '/', 'http://x');
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      const out = await paywall.handle({
        method: req.method ?? 'GET', path: url.pathname, headers, body: chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined,
      });
      res.writeHead(out.status, { 'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE', ...out.headers });
      res.end(out.body ?? '');
    } catch (e: any) {
      res.writeHead(500).end('internal error');
      console.error(e);
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
