import { createServer } from 'node:http';
import { NamedConfigurationStore } from '../../../../src/core/named-configuration-store.js';
import { bindNamedConfigurationDocument, deserializeNamedConfiguration } from '../../../../src/http/named-configuration-binding.js';
import { BindingError, HttpResult, readBody } from '../../../../src/http/binding.js';
import { stringifyNativeJson } from '../../../../src/core/json.js';
import { AuthenticationService } from '../../../../src/users/authentication-service.js';

// A component host for the existing production body/auth/error functions and
// new named action boundary. Production route registration is tested separately
// once the runtime installs this store; this host does not claim that wiring.
export function nfoComponentHost({ configurationDirectoryPath, onError, onFailure, fileSystem }) {
  const store = new NamedConfigurationStore({ configurationDirectoryPath, onError, ...(fileSystem && { fileSystem }) });
  const authorization = new AuthenticationService({ store: {}, users: {}, serverId: 'named-component', isLocalNetwork: () => true });
  let accepting = true;
  const pending = new Set();
  const server = createServer((request, response) => {
    const work = (async () => {
      let phase = 'admission';
      const send = result => {
        const value = result instanceof HttpResult ? result : new HttpResult(200, result);
        if (value.body === undefined) { response.writeHead(value.status); response.end(); return; }
        const body = value.text ? String(value.body) : stringifyNativeJson(value.body);
        response.writeHead(value.status, { 'Content-Type': value.text ? 'text/plain' : 'application/json; charset=utf-8' }); response.end(body);
      };
      try {
        if (!accepting) throw Object.assign(new Error('The named component host is closing.'), { code: 'closed', status: 503 });
        const key = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.split('/').at(-1));
        const identity = request.headers['x-identity'] ?? 'admin';
        const authenticated = !['anonymous', 'invalid'].includes(identity);
        const auth = { IsAuthenticated: authenticated, IsAdministrator: authenticated && identity !== 'regular', IsApiKey: identity === 'apiKey',
          UserId: 'f82b0000000000000000000000000001', User: { Id: 'f82b0000000000000000000000000001',
            Policy: { EnableRemoteAccess: true, IsAdministrator: false }, AccessSchedules: [] } };
        try { authorization.authorize(auth, { policy: request.method === 'POST' ? 'RequiresElevation' : 'Default', startupWizardCompleted: true }); }
        catch (error) { if (![401, 403].includes(error.status)) throw error; send(new HttpResult(error.status)); return; }
        if (request.method === 'GET') { phase = 'load'; send(await store.getConfiguration(key)); return; }
        let document; phase = 'json-document';
        try { document = await readBody(request, { document: true, bind: bindNamedConfigurationDocument }); }
        catch (error) {
          if (error instanceof BindingError && !Object.hasOwn(error.errors, 'configuration')) error.errors.configuration = ['The configuration field is required.'];
          throw error;
        }
        phase = 'deserialize'; const value = deserializeNamedConfiguration(key, document);
        phase = 'save'; await store.saveConfiguration(key, value); send(new HttpResult(204));
      } catch (error) {
        if (error instanceof HttpResult) { send(error); return; }
        if (error instanceof BindingError) { send(new HttpResult(400, error.problem())); return; }
        onFailure({ method: request.method, url: request.url, phase, error });
        onError(error);
        if (response.headersSent) { response.destroy(error); return; }
        response.writeHead(error.status ?? error.statusCode ?? 500, { 'Content-Type': 'text/plain' }); response.end('Error processing request.');
      }
    })();
    pending.add(work); void work.finally(() => pending.delete(work)).catch(error => onError(error));
  });
  return { store, server, async close() {
    accepting = false; await Promise.allSettled([...pending]); await store.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
