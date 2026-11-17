/**
 * supabase/local-dev/m61-shim.mjs
 * --------------------------------
 * Phase 6.1 verification-only reverse proxy for the ISOLATED local stack.
 *
 * Routes (all under one origin so unmodified supabase-js works):
 *   /rest/v1/*  -> PostgREST  (m61-pgrst, tables under public)
 *   /auth/v1/*  -> GoTrue     (m61-gotrue, real signup/token/user)
 *   anything else -> 404
 *
 * NOT part of production. No secrets here: ports come from the
 * environment; JWT validation happens inside PostgREST/GoTrue.
 */

import http from 'node:http';

const PORT = Number(process.env.SHIM_PORT ?? 55437);
const PGRST = { host: process.env.POSTGREST_HOST ?? '127.0.0.1', port: Number(process.env.POSTGREST_PORT ?? 55436) };
const GOTRUE = { host: process.env.GOTRUE_HOST ?? '127.0.0.1', port: Number(process.env.GOTRUE_PORT ?? 55435) };

const ROUTES = [
  { prefix: '/rest/v1', strip: '/rest/v1', target: PGRST },
  { prefix: '/auth/v1', strip: '/auth/v1', target: GOTRUE },
];

/**
 * CORS for the local dev stack.
 *
 * GoTrue's own preflight (OPTIONS) responses come back WITHOUT
 * `Access-Control-Allow-Origin`, which makes browsers reject signup/login
 * before the real request is even sent. PostgREST handles CORS correctly,
 * so we only need to fill the gap here:
 *   - answer OPTIONS preflights ourselves, and
 *   - add the header to any proxied response that lacks it.
 *
 * Origins are restricted to loopback dev origins; everything is bound to
 * 127.0.0.1 and this shim is NOT part of production.
 */
function allowOriginFor(origin) {
  if (!origin) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null; // unknown origin: do not grant access
}

function corsHeaders(req) {
  const allow = allowOriginFor(req.headers.origin);
  if (!allow) return {};
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  // Preflight: answer directly with CORS headers (both routes).
  if (req.method === 'OPTIONS') {
    const headers = corsHeaders(req);
    if (headers['access-control-allow-origin']) {
      headers['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
      headers['access-control-allow-headers'] =
        req.headers['access-control-request-headers'] ??
        'authorization, apikey, content-type, x-client-info';
      headers['access-control-max-age'] = '86400';
      res.writeHead(204, headers);
    } else {
      res.writeHead(403, { 'content-type': 'application/json' });
    }
    res.end();
    return;
  }

  const route = ROUTES.find((r) => url === r.prefix || url.startsWith(r.prefix + '/'));
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify({ message: 'not found', path: url }));
    return;
  }
  const upstreamPath = url.slice(route.strip.length) || '/';

  const upstream = http.request(
    {
      host: route.target.host,
      port: route.target.port,
      method: req.method,
      path: upstreamPath,
      headers: { ...req.headers, host: `${route.target.host}:${route.target.port}` },
    },
    (up) => {
      const headers = { ...up.headers };
      const cors = corsHeaders(req);
      // Normalize ACAO to the exact allowed loopback origin (overrides
      // GoTrue's `*`, which cannot be combined with allow-credentials).
      if (cors['access-control-allow-origin']) {
        Object.assign(headers, cors);
      }
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json', ...corsHeaders(req) });
    }
    res.end(JSON.stringify({ message: String(err) }));
  });

  req.pipe(upstream);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[m61-shim] :${PORT} rest/v1 -> ${PGRST.host}:${PGRST.port}, auth/v1 -> ${GOTRUE.host}:${GOTRUE.port}`);
});
