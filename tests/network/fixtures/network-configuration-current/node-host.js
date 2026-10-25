import { createServer, request as httpRequest } from 'node:http';
import { WebSocketServer } from 'ws';
import { NamedConfigurationStore } from '../../../../src/core/named-configuration-store.js';
import { defaultConfiguration } from '../../../../src/core/configuration-xml.js';
import { stringifyNativeJson, parseLosslessJson } from '../../../../src/core/json.js';
import { NetworkService } from '../../../../src/network/network-service.js';
import { baseUrlRedirect, requestIsLocal, requestPath } from '../../../../src/network/http-request.js';
import { AuthenticationService } from '../../../../src/users/authentication-service.js';
import { StartupService } from '../../../../src/users/startup-service.js';
import { registerConfigurationRoutes } from '../../../../src/http/configuration-routes.js';
import { registerStartupRoutes } from '../../../../src/http/startup-routes.js';
import { BindingError, HttpResult, readBody } from '../../../../src/http/binding.js';
import { namedError } from '../../../core/named-configuration-current.js';

// Explicit component boundary: production route actions, bindings, network and
// authorization functions run here. Credential resolution and transport echo
// are controlled gateways. The separate formal-runtime test owns app wiring.
export async function networkComponentHost({ directory, interfaces, initial = {}, onError, owner = () => null }) {
  const store = new NamedConfigurationStore({ configurationDirectoryPath: directory, onError });
  const first = Object.assign(defaultConfiguration('network'), initial); await store.saveConfiguration('network', first);
  const baseUrl = first.BaseUrl, configuration = defaultConfiguration('server');
  configuration.IsStartupWizardCompleted = true;
  const failures = [], pending = new Set(), routes = [];
  let accepting = true, closing;
  const network = new NetworkService({ getNetworkConfiguration: () => store.getCurrentConfiguration('network'), namedConfiguration: store,
    getInterfaces: () => interfaces,
    getApplicationHost: () => ({ httpPort: first.InternalHttpPort, httpsPort: first.InternalHttpsPort, listenWithHttps: false }),
    lookup: async host => { throw new Error('Unspecified DNS fixture: ' + host); } });
  const authorization = new AuthenticationService({ store: {}, users: {}, serverId: 'network-component', isLocalNetwork: address => network.isInLocalNetwork(address) });
  const startup = new StartupService({ users: {}, configuration, namedConfiguration: store });
  const add = (method, paths, run, options = {}) => {
    for (const path of Array.isArray(paths) ? paths : [paths]) {
      const names = [];
      const expression = path.split(/(\{\w+\})/u).map(part => {
        if (/^\{\w+\}$/u.test(part)) { names.push(part.slice(1, -1)); return '([^/]+)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      }).join('');
      routes.push({ method, run, names, pattern: new RegExp('^' + expression + '/?$', 'iu'), ...options });
    }
  };
  registerConfigurationRoutes(add, { configuration, namedConfiguration: store }); registerStartupRoutes(add, { startup });
  const identity = request => {
    const name = request.headers['x-identity'] ?? 'admin', authenticated = !['anonymous', 'invalid'].includes(name);
    return { IsAuthenticated: authenticated, IsAdministrator: authenticated && name !== 'regular', IsApiKey: name === 'apiKey',
      UserId: 'f82b0000000000000000000000000001', User: { Id: 'f82b0000000000000000000000000001',
        Policy: { EnableRemoteAccess: true, IsAdministrator: name !== 'regular' }, AccessSchedules: [] } };
  };
  const mappedPath = request => {
    const path = requestPath(request);
    return baseUrl && path.toLowerCase() !== baseUrl.toLowerCase() && !path.toLowerCase().startsWith(baseUrl.toLowerCase() + '/')
      ? null : path.slice(baseUrl.length) || '/';
  };
  const server = createServer((request, response) => {
    const work = (async () => {
      let phase = 'admission';
      const send = value => {
        const result = value instanceof HttpResult ? value : new HttpResult(200, value);
        response.statusCode = result.status;
        if (result.body === undefined) { response.end(); return; }
        response.setHeader('Content-Type', result.text ? 'text/plain' : 'application/json; charset=utf-8');
        response.end(result.text ? String(result.body) : stringifyNativeJson(result.body));
      };
      try {
        if (!accepting) { send(new HttpResult(503)); return; }
        phase = 'base-url-redirect';
        const redirect = baseUrlRedirect(request, store.getCurrentConfiguration('network').BaseUrl);
        if (redirect !== null) { response.writeHead(302, { Location: redirect }); response.end(); return; }
        phase = 'routing';
        const path = mappedPath(request);
        if (path === null) { send(new HttpResult(404)); return; }
        const matches = routes.flatMap(route => {
          const match = route.pattern.exec(path); if (!match || route.method !== request.method) return [];
          const params = Object.fromEntries(route.names.map((name, index) => [name, match[index + 1]]));
          return route.names.every(name => !route.constraints?.[name] || route.constraints[name](params[name])) ? [{ route, params }] : [];
        });
        const selected = matches[0];
        if (!selected) { send(new HttpResult(404)); return; }
        const { route, params } = selected, info = network.getRequestInfo(request);
        phase = 'authorization';
        try { authorization.authorize(identity(request), { policy: route.policy ?? 'Default', startupWizardCompleted: true, remoteEndPoint: info.remoteEndPoint }); }
        catch (error) { if (![401, 403].includes(error.status)) throw error; send(new HttpResult(error.status)); return; }
        phase = 'ip';
        if (!requestIsLocal(info) && !network.shouldAllowServerAccess(info.remoteEndPoint)) { send(new HttpResult(503)); return; }
        let body;
        if (route.body) {
          phase = route.bodyDocument ? 'json-document' : 'typed-body';
          try { body = await readBody(request, { document: route.bodyDocument, bind: route.bindBody, objectType: route.bodyType }); }
          catch (error) {
            if (route.bodyParameter && error instanceof BindingError && !error.modelValidated && !Object.hasOwn(error.errors, route.bodyParameter)) {
              error.errors[route.bodyParameter] = ['The ' + route.bodyParameter + ' field is required.'];
            }
            throw error;
          }
        }
        phase = 'action'; send(await route.run({ request, params, body }));
      } catch (error) {
        if (error instanceof HttpResult) { send(error); return; }
        if (error instanceof BindingError) {
          failures.push({ owner: structuredClone(owner()), phase, method: request.method, path: request.url, error: namedError(error) });
          send(new HttpResult(400, error.problem())); return;
        }
        failures.push({ owner: structuredClone(owner()), phase, method: request.method, path: request.url, error: namedError(error) }); onError(error);
        if (phase === 'base-url-redirect') { response.writeHead(500); response.end(); return; }
        response.writeHead(error.status ?? error.statusCode ?? 500, { 'Content-Type': 'text/plain' }); response.end('Error processing request.');
      }
    })();
    pending.add(work); void work.finally(() => pending.delete(work)).catch(onError);
  });
  const sockets = new Set(), wss = new WebSocketServer({ noServer: true });
  wss.on('connection', socket => { sockets.add(socket); socket.on('error', onError); socket.once('close', () => sockets.delete(socket));
    socket.on('message', (data, binary) => socket.send(data, { binary }, error => { if (error) onError(error); })); });
  server.on('upgrade', (request, socket, head) => {
    try {
      const redirect = baseUrlRedirect(request, store.getCurrentConfiguration('network').BaseUrl);
      if (redirect !== null) { socket.end('HTTP/1.1 302 Found\r\nLocation: ' + redirect + '\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
      const info = network.getRequestInfo(request);
      const status = !accepting ? 503 : mappedPath(request) === null ? 404
        : !requestIsLocal(info) && !network.shouldAllowServerAccess(info.remoteEndPoint) ? 503 : null;
      if (status) { socket.end('HTTP/1.1 ' + status + ' Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
    } catch (error) { onError(error); socket.destroy(error); }
  });
  try {
    await network.initialize();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  } catch (primary) {
    const errors = [primary]; for (const operation of [() => network.close(), () => startup.close(), () => store.close()]) try { await operation(); } catch (error) { errors.push(error); }
    throw errors.length === 1 ? primary : new AggregateError(errors, 'Network component startup cleanup failed.', { cause: primary });
  }
  return { store, network, server, failures, async request(method, route, body, name = 'admin', forwarded, upgrade = false) {
    return await new Promise((resolve, reject) => {
      const headers = { Accept: 'application/json', 'X-Identity': name, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(forwarded ? { 'X-Forwarded-For': forwarded } : {}), ...(upgrade ? { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('network-fixture!').toString('base64') } : {}) };
      const request = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: route, method, headers }, response => {
        const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('error', reject);
        response.on('end', () => { const bytes = Buffer.concat(chunks), text = bytes.toString(); let json = null; try { json = parseLosslessJson(text); } catch { }
          resolve({ status: response.statusCode, headers: response.headers, contentType: response.headers['content-type'] ?? null, text, json, bodyBase64: bytes.toString('base64'), error: null }); });
      });
      request.on('upgrade', (response, socket) => { socket.destroy(); reject(new Error('A rejected fixture upgrade unexpectedly succeeded with ' + response.statusCode)); });
      request.on('error', reject); request.end(body);
    });
  }, close() { return closing ??= (async () => {
    accepting = false; const errors = [];
    for (const socket of sockets) socket.close(1000, 'fixture finished');
    const closeSockets = new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    for (const operation of [() => closeSockets, () => Promise.all([...pending]), () => startup.close(), () => network.close(), () => store.close(),
      () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]) try { await operation(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Network component resources failed to close.', { cause: errors[0] });
  })(); } };
}
