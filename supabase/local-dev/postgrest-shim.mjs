/**
 * supabase/local-dev/postgrest-shim.mjs
 * -------------------------------------
 * Local verification-only reverse proxy.
 *
 * Supabase-js always calls `<SUPABASE_URL>/rest/v1/...`, but a plain
 * PostgREST container serves tables at `/`. This shim strips the
 * `/rest/v1` prefix so the unmodified application code can talk to a
 * local PostgREST instance during isolated verification.
 *
 * NOT part of production. No secrets are stored here: the JWT secret and
 * tokens are supplied through the environment / PostgREST container.
 */

import http from 'node:http';

const PORT = Number(process.env.SHIM_PORT ?? 54321);
const TARGET_HOST = process.env.POSTGREST_HOST ?? '127.0.0.1';
const TARGET_PORT = Number(process.env.POSTGREST_PORT ?? 54322);
const PREFIX = '/rest/v1';

const server = http.createServer((req, res) => {
  let url = req.url ?? '/';
  if (url.startsWith(PREFIX)) url = url.slice(PREFIX.length) || '/';

  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: url,
      headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ message: String(err) }));
  });

  req.pipe(upstream);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[postgrest-shim] ${PORT} -> ${TARGET_HOST}:${TARGET_PORT}${PREFIX}`);
});
