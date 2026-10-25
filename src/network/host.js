import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import * as fs from 'node:fs/promises';
import { clrTrim } from '../metadata/whitespace.js';
import { loadServerCertificate } from './certificate.js';

const closed = () => Object.assign(new Error('The network host is closing.'), { code: 'closed', status: 503 });
const nonempty = value => value != null && clrTrim(value) !== '';
const absent = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG', 'ELOOP', 'EIO', 'ENODEV', 'ENXIO', 'ERR_INVALID_ARG_VALUE']);
const combined = (errors, message) => errors.length === 1 ? errors[0] : new AggregateError(errors, message, { cause: errors[0] });

// AppHost captures ports and certificate material once. Current configuration
// continues to control advertised URLs and restart checks, never live rebinds.
export class NetworkHost {
  #controller = new AbortController();
  #initializing;
  #starting;
  #closing;
  #closed = false;
  #httpPort;
  #httpsPort;
  #certificatePath;
  #certificate;
  #baseUrl;
  #redirectHttps = false;
  #pendingRestart = false;
  #startupComplete = false;
  #listeners = [];
  #sockets = new Set();
  #backgroundErrors = [];
  #updated;
  #observing = false;

  constructor({ network, getNetworkConfiguration, getSystemConfiguration, configurationStore, namedConfiguration,
    fileSystem = fs, onError = () => {}, fallbackUrl = 'http://localhost:5000' }) {
    if (!network || typeof getNetworkConfiguration !== 'function' || typeof getSystemConfiguration !== 'function') {
      throw new TypeError('A network host requires the network and current configuration owners.');
    }
    Object.assign(this, { network, getNetworkConfiguration, getSystemConfiguration, configurationStore, namedConfiguration, fileSystem, onError, fallbackUrl });
    this.#updated = () => this.#configurationUpdated();
  }

  get signal() { return this.#controller.signal; }
  get httpPort() { return this.#httpPort; }
  get httpsPort() { return this.#httpsPort; }
  get baseUrl() { return this.#baseUrl; }
  get listenWithHttps() { return this.#certificate != null && this.getNetworkConfiguration().EnableHttps; }
  get hasPendingRestart() { return this.#pendingRestart; }
  get coreStartupHasCompleted() { return this.#startupComplete; }
  get listeners() { return this.#listeners.map(({ scheme, address, port, family, server, bound }) => ({ scheme, address, port, family, server, bound })); }

  initialize() {
    if (this.#closed) return Promise.reject(closed());
    return this.#initializing ??= (async () => {
      const current = this.getNetworkConfiguration();
      this.#httpPort = current.InternalHttpPort;
      this.#httpsPort = current.InternalHttpsPort;
      if (this.#httpPort === this.#httpsPort) { this.#httpPort = 8096; this.#httpsPort = 8920; }
      this.#certificatePath = current.CertificatePath;
      this.#certificate = await loadServerCertificate({ filename: this.#certificatePath, password: current.CertificatePassword,
        fileSystem: this.fileSystem, signal: this.signal, onError: this.onError });
      this.signal.throwIfAborted();
      this.#baseUrl = current.BaseUrl;
      this.#redirectHttps = Boolean(current.RequireHttps && this.listenWithHttps);
    })();
  }

  httpsRedirect(request, info) {
    if (!this.#redirectHttps || info.scheme.toLowerCase() === 'https') return null;
    const target = new URL('https://' + info.host);
    target.port = this.#httpsPort === 443 ? '' : String(this.#httpsPort);
    // Redirect preserves the encoded origin-form path and query, including a
    // captured Map prefix. Forwarded scheme/host were processed by the caller.
    return target.origin + (request.url?.startsWith('/') ? request.url : new URL(request.url, target).pathname + new URL(request.url, target).search);
  }

  start(application) {
    if (this.#closed) return Promise.reject(closed());
    if (typeof application?.handler !== 'function') return Promise.reject(new TypeError('An application request handler is required.'));
    return this.#starting ??= this.#start(application);
  }

  async #start(application) {
    try {
      await this.initialize();
      this.signal.throwIfAborted();
      if (this.#baseUrl && this.#baseUrl.endsWith('/')) throw Object.assign(new TypeError('The application path prefix must not end with a slash.'), { code: 'invalid-application-path' });
      const addresses = this.network.getAllBindInterfaces();
      const specifications = addresses.flatMap(address => [
        { scheme: 'http', address, port: this.#httpPort },
        ...(this.listenWithHttps ? [{ scheme: 'https', address, port: this.#httpsPort }] : []),
      ]);
      if (!specifications.length) {
        const fallback = new URL(this.fallbackUrl);
        if (fallback.protocol !== 'http:' || fallback.pathname !== '/' || fallback.search || fallback.hash) throw new TypeError('An HTTP listener fallback origin is required.');
        const port = fallback.port ? Number(fallback.port) : 80;
        if (fallback.hostname === 'localhost') {
          if (port === 0) throw Object.assign(new Error('A dynamic localhost listener must select an explicit loopback address.'), { code: 'invalid-listener-address' });
          specifications.push({ scheme: 'http', address: '127.0.0.1', port, optional: true }, { scheme: 'http', address: '::1', port, optional: true });
        } else specifications.push({ scheme: 'http', address: fallback.hostname.replace(/^\[|\]$/gu, ''), port });
      }
      const unavailable = [];
      for (const specification of specifications) {
        this.signal.throwIfAborted();
        try { await this.#listen(specification, application); }
        catch (error) {
          if (!specification.optional || error.code === 'EADDRINUSE' || this.signal.aborted) throw error;
          unavailable.push(error);
        }
      }
      if (!this.#listeners.some(entry => entry.server.listening)) throw combined(unavailable, 'No localhost listener could start.');
      this.signal.throwIfAborted();
      this.configurationStore?.on('updated', this.#updated);
      this.namedConfiguration?.on('updated', this.#updated);
      this.#observing = true;
      return this.listeners;
    } catch (error) {
      this.#closed = true;
      this.#controller.abort(error);
      try { await this.#closeListeners(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Network startup and listener rollback failed.', { cause: error }); }
      throw error;
    }
  }

  async #listen(specification, application) {
    const server = specification.scheme === 'https' ? createHttpsServer(this.#certificate, application.handler) : createHttpServer(application.handler);
    const entry = { ...specification, server, bound: false };
    entry.closed = new Promise(resolve => server.once('close', resolve));
    this.#listeners.push(entry);
    server.on('connection', socket => { this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket)); });
    application.webSockets?.attach(server);
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', listening); this.signal.removeEventListener('abort', aborted); reject(error); };
        const listening = () => { entry.bound = true; Object.assign(entry, server.address()); server.off('error', failed); this.signal.removeEventListener('abort', aborted); resolve(); };
        const aborted = () => failed(this.signal.reason);
        server.once('error', failed).once('listening', listening);
        this.signal.addEventListener('abort', aborted, { once: true });
        try { this.signal.throwIfAborted(); server.listen({ host: specification.address, port: specification.port, ipv6Only: specification.address !== '::', signal: this.signal }); }
        catch (error) { server.off('error', failed); failed(error); }
      });
      server.on('error', error => {
        this.#backgroundErrors.push(error);
        try { void Promise.resolve(this.onError(error, { phase: 'listener', scheme: entry.scheme, address: entry.address, port: entry.port })).catch(failure => this.#backgroundErrors.push(failure)); }
        catch (failure) { this.#backgroundErrors.push(failure); }
      });
    } catch (error) { application.webSockets?.detach(server); throw error; }
  }

  completeStartup() { this.signal.throwIfAborted(); this.#startupComplete = true; }

  async #configurationUpdated() {
    const network = this.getNetworkConfiguration(), system = this.getSystemConfiguration();
    let restart = false;
    if (this.#httpPort !== 0 && this.#httpsPort !== 0
      && (network.InternalHttpPort !== this.#httpPort || network.InternalHttpsPort !== this.#httpsPort) && system.IsPortAuthorized) {
      system.IsPortAuthorized = false;
      await this.configurationStore.saveConfiguration();
      restart = true;
    }
    if (nonempty(network.CertificatePath) && network.CertificatePath !== this.#certificatePath) {
      let exists = false, cause;
      try { exists = (await this.fileSystem.stat(network.CertificatePath)).isFile(); }
      catch (error) { if (!absent.has(error.code)) throw error; cause = error; }
      if (!exists) throw Object.assign(new Error(`Certificate file '${network.CertificatePath}' does not exist.`, cause ? { cause } : undefined), { code: 'ENOENT', status: 404 });
      restart = true;
    }
    if (restart) this.#pendingRestart = true;
  }

  beginClose() { this.#closed = true; this.#controller.abort(closed()); }

  detachConfiguration() {
    if (!this.#observing) return;
    this.configurationStore?.off('updated', this.#updated);
    this.namedConfiguration?.off('updated', this.#updated);
    this.#observing = false;
  }

  close() {
    if (this.#closing) return this.#closing;
    this.beginClose();
    return this.#closing = (async () => {
      await Promise.allSettled([this.#initializing, this.#starting]);
      this.detachConfiguration();
      await this.#closeListeners();
      if (this.#backgroundErrors.length) throw combined(this.#backgroundErrors, 'The network listener failed.');
    })();
  }

  async #closeListeners() {
    const errors = [];
    const socketsClosed = [...this.#sockets].map(socket => new Promise(resolve => {
      if (socket.closed) resolve(); else socket.once('close', resolve);
      socket.destroy();
    }));
    for (const entry of this.#listeners) {
      try {
        entry.server.closeAllConnections();
        if (entry.server.listening) await new Promise((resolve, reject) => entry.server.close(error => error ? reject(error) : resolve()));
        if (entry.bound) await entry.closed;
      } catch (error) { errors.push(error); }
    }
    await Promise.all(socketsClosed);
    if (errors.length) throw combined(errors, 'Network listeners could not close.');
  }
}
