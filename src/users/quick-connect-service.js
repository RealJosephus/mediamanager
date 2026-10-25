import { randomBytes, randomInt } from 'node:crypto';
import { domainError, wireDate } from './native.js';

const timeout = 10 * 60_000;

export class QuickConnectService {
  #requests = new Map();
  #authorized = new Map();
  #pending = new Set();
  #closed = false;
  #closing;

  constructor(options) {
    const { configuration, authentication, now = () => new Date() } = options;
    if (!configuration || typeof authentication?.authenticateDirect !== 'function') {
      throw new TypeError('Quick connect requires configuration and direct authentication.');
    }
    Object.assign(this, { options, authentication, now });
  }

  get configuration() { return this.options.configuration; }

  get enabled() { return this.configuration.QuickConnectAvailable ?? true; }

  #assertActive() {
    if (this.#closed) throw domainError(503, 'Quick connect is closed.');
    if (!this.enabled) throw domainError(401, 'Quick connect is not active on this server');
  }

  #expire() {
    const minimum = this.now().getTime() - timeout;
    for (const [code, request] of this.#requests) if (Date.parse(request.DateAdded) < minimum) this.#requests.delete(code);
    for (const [secret, result] of this.#authorized) if (result.timestamp < minimum) this.#authorized.delete(secret);
  }

  initiate(authorization) {
    for (const field of ['DeviceId', 'Device', 'Client', 'Version']) {
      if (typeof authorization[field] !== 'string' || !authorization[field]) throw domainError(400, `${field} is required.`);
    }
    this.#assertActive();
    this.#expire();
    const result = { Authenticated: false, Secret: randomBytes(32).toString('hex').toUpperCase(),
      Code: String(randomInt(100000, 1000000)), DeviceId: authorization.DeviceId, DeviceName: authorization.Device,
      AppName: authorization.Client, AppVersion: authorization.Version, DateAdded: wireDate(this.now().toISOString()) };
    this.#requests.set(result.Code, result);
    return { ...result };
  }

  connect(secret) {
    this.#assertActive();
    this.#expire();
    for (const request of this.#requests.values()) if (request.Secret === secret) return { ...request };
    throw domainError(404, 'Unable to find request with provided secret');
  }

  authorize(userId, code) {
    try {
      this.#assertActive();
      this.#expire();
      const request = this.#requests.get(code);
      if (!request) throw domainError(404, 'Unable to find request');
      if (request.Authenticated) throw domainError(500, 'Request is already authorized');
      // Native authorization advances the pending request before authentication,
      // including a failed attempt. Its result has a separate ten-minute expiry.
      request.DateAdded = wireDate(new Date(this.now().getTime() + 60_000).toISOString());
      const operation = Promise.resolve().then(() => this.authentication.authenticateDirect(userId, {
        DeviceId: request.DeviceId, Device: request.DeviceName, Client: request.AppName, Version: request.AppVersion
      })).then(result => {
        this.#authorized.set(request.Secret, { timestamp: this.now().getTime(), result });
        request.Authenticated = true;
        this.#requests.set(code, request);
        return true;
      });
      this.#pending.add(operation);
      void operation.then(() => this.#pending.delete(operation), () => this.#pending.delete(operation));
      return operation;
    } catch (error) { return Promise.reject(error); }
  }

  authenticate(secret) {
    this.#assertActive();
    this.#expire();
    const authorized = this.#authorized.get(secret);
    if (!authorized) throw domainError(404, 'Unable to find request');
    return authorized.result;
  }

  close() {
    this.#closed = true;
    return this.#closing ??= (async () => {
      await Promise.allSettled([...this.#pending]);
      this.#requests.clear();
      this.#authorized.clear();
    })();
  }
}
