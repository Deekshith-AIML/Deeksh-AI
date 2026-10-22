/**
 * server.ts
 * ---------
 * Process entry point: load environment variables, import the assembled
 * Express app (app.ts), and start listening.
 *
 * All application wiring (CORS, routes, auth, error handling) lives in
 * app.ts so the test suite can import the same app without opening a port.
 */

import 'dotenv/config';
import app from './app.js';

const PORT = Number(process.env.PORT ?? 3001);

app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});
