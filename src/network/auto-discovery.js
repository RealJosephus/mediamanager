import { createSocket as createDatagramSocket } from 'node:dgram';

const discoveryQuestion = 'who is JellyfinServer?';
const defaultCloseTimeoutMs = 1_000;

function abortError() {
  return Object.assign(new Error('UDP auto-discovery was closed.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function report(onError, error) {
  try { void Promise.resolve(onError(error)).catch(() => {}); }
  catch { /* Background error reporting cannot change discovery state. */ }
}

function asciiFold(code) {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function containsOrdinalIgnoreCase(value, search) {
  if (search.length > value.length) return false;
  for (let offset = 0; offset <= value.length - search.length; offset++) {
    let matches = true;
    for (let index = 0; index < search.length; index++) {
      if (asciiFold(value.charCodeAt(offset + index)) !== asciiFold(search.charCodeAt(index))) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function serializeDiscoveryInfo({ Address, Id, Name }) {
  return JSON.stringify({ Address: Address.toWellFormed(), Id: Id.toWellFormed(),
    Name: Name.toWellFormed(), EndpointAddress: null });
}

function closeSocket(socket) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      socket.off?.('close', closed);
      socket.off?.('error', failed);
      if (error) reject(error); else resolve();
    };
    const closed = () => finish();
    const failed = error => finish(error);
    socket.once('close', closed);
    socket.once('error', failed);
    try { socket.close(); }
    catch (error) {
      if (error?.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') finish();
      else finish(error);
    }
  });
}

function bounded(operation, timeoutMs, message) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

export class AutoDiscoveryService {
  #closed = false;
  #closePromise;
  #controller = new AbortController();
  #listening = false;
  #socket;
  #socketClosePromise;
  #startPromise;
  #tail = Promise.resolve();

  constructor({ enabled = true, serverId, serverName = 'MediaManager', resolveAddress,
    createSocket = createDatagramSocket, host = '0.0.0.0', port = 7359,
    closeTimeoutMs = defaultCloseTimeoutMs, onError = () => {} } = {}) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    if (typeof serverId !== 'string' || !serverId) throw new TypeError('serverId must be a nonempty string.');
    if (typeof serverName !== 'string') throw new TypeError('serverName must be a string.');
    if (typeof resolveAddress !== 'function') throw new TypeError('resolveAddress must be a function.');
    if (typeof createSocket !== 'function') throw new TypeError('createSocket must be a function.');
    if (typeof host !== 'string' || !host) throw new TypeError('host must be a nonempty string.');
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('port must be an integer from 0 through 65535.');
    if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs <= 0) throw new TypeError('closeTimeoutMs must be a positive safe integer.');
    if (typeof onError !== 'function') throw new TypeError('onError must be a function.');
    Object.assign(this, { enabled, serverId, serverName, resolveAddress, createSocket, host, port, closeTimeoutMs, onError });
  }

  get listening() { return this.#listening; }

  address() {
    if (!this.#listening || !this.#socket) return null;
    try { return this.#socket.address(); }
    catch { return null; }
  }

  start() {
    if (!this.enabled) return Promise.resolve(null);
    if (this.#closed) return Promise.reject(abortError());
    return this.#startPromise ??= this.#start();
  }

  async #start() {
    const socket = this.createSocket('udp4');
    this.#socket = socket;
    let opening = true;
    const ready = Promise.withResolvers();
    const onError = error => opening ? ready.reject(error) : report(this.onError, error);
    const onClose = () => {
      this.#listening = false;
      if (opening) ready.reject(this.#closed ? abortError() : new Error('UDP auto-discovery socket closed before listening.'));
    };
    const onMessage = (message, remote) => {
      if (this.#closed) return;
      const operation = this.#tail.then(() => this.#respond(message, remote));
      this.#tail = operation.catch(error => {
        if (!this.#closed && error?.name !== 'AbortError') report(this.onError, error);
      });
    };
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('message', onMessage);
    socket.once('listening', ready.resolve);
    try {
      socket.bind({ address: this.host, port: this.port, exclusive: true });
      await ready.promise;
      if (this.#closed) throw abortError();
      socket.setMulticastLoopback(false);
      opening = false;
      this.#listening = true;
      return socket.address();
    } catch (error) {
      opening = false;
      socket.off('message', onMessage);
      await this.#closeSocket(socket).catch(closeError => {
        throw new AggregateError([error, closeError], 'UDP auto-discovery startup and rollback failed.');
      });
      throw error;
    }
  }

  async #respond(message, remote) {
    if (!containsOrdinalIgnoreCase(message.toString('utf8'), discoveryQuestion)) return;
    const Address = await this.resolveAddress(remote, { signal: this.#controller.signal });
    if (this.#closed || this.#controller.signal.aborted || Address == null || Address === '') return;
    if (typeof Address !== 'string') throw new TypeError('Discovery address resolver must return a string or null.');
    const payload = Buffer.from(serializeDiscoveryInfo({
      Address,
      Id: this.serverId,
      Name: this.serverName
    }), 'utf8');
    await new Promise((resolve, reject) => {
      try { this.#socket.send(payload, remote.port, remote.address, error => error ? reject(error) : resolve()); }
      catch (error) { reject(error); }
    });
  }

  #closeSocket(socket) {
    if (this.#socketClosePromise) return this.#socketClosePromise;
    this.#socketClosePromise = bounded(closeSocket(socket), this.closeTimeoutMs,
      'Timed out closing the UDP auto-discovery socket.').finally(() => {
        if (this.#socket === socket) this.#socket = undefined;
        this.#listening = false;
      });
    return this.#socketClosePromise;
  }

  close() {
    if (!this.#closePromise) {
      const completion = Promise.withResolvers();
      this.#closePromise = completion.promise;
      this.#closed = true;
      this.#controller.abort();
      void this.#close().then(completion.resolve, completion.reject);
    }
    return this.#closePromise;
  }

  async #close() {
    const errors = [];
    if (this.#socket) {
      try { await this.#closeSocket(this.#socket); }
      catch (error) { errors.push(error); }
    }
    const pending = Promise.allSettled([this.#startPromise, this.#tail].filter(Boolean));
    try { await bounded(pending, this.closeTimeoutMs, 'Timed out draining UDP auto-discovery work.'); }
    catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'UDP auto-discovery could not close cleanly.');
  }
}
