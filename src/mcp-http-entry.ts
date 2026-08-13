import { startMcpHttpServer } from './mcp-http.js';

try {
  await startMcpHttpServer();
} catch (err) {
  console.error(err);
  process.exit(1);
}
