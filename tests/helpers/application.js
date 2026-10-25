import { createServer } from 'node:http';
import { createApplication } from '../../src/http/application.js';

// Component fixtures explicitly own a plain HTTP transport. Formal runtime
// tests use NetworkHost, including its real bind/TLS/startup/rollback lifecycle.
export async function createTestApplication(services) {
  const application = await createApplication(services);
  const server = createServer(application.handler);
  application.webSockets?.attach(server);
  return { ...application, server };
}
