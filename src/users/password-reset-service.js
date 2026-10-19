import path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { md5Guid } from '../core/identity.js';
import { tokenizeJson } from '../core/json-tokens.js';
import { parseJsonDateTime } from '../http/json-date-time.js';
import { epochTicks } from '../syncplay/time.js';
import { clrTrim } from '../metadata/whitespace.js';
import { PASSWORD_RESET_PROVIDER, domainError, equalsIgnoreCase, upperInvariant, wireDate } from './native.js';

const prefix = 'passwordreset';
const currentTicks = now => epochTicks + BigInt(now().getTime()) * 10000n;

async function physicalPath(filename, { missing = false } = {}) {
  let current = path.resolve(filename);
  while (true) {
    try {
      const entry = await fs.lstat(current);
      if (entry.isSymbolicLink()) throw domainError(409, 'Password reset storage traverses a link or junction.');
      const actual = await fs.realpath(current);
      if (path.relative(path.toNamespacedPath(current), path.toNamespacedPath(actual)) !== '') {
        throw domainError(409, 'Password reset storage traverses a link or junction.');
      }
      return;
    } catch (error) {
      if (error.code !== 'ENOENT' || !missing) throw error;
      const parent = path.dirname(current); if (parent === current) throw error; current = parent;
    }
  }
}

function readResetFile(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  JSON.parse(text);
  const root = tokenizeJson(text);
  if (root.value === null && !root.properties) throw domainError(404, 'The password reset document is null.');
  if (!root.properties) throw new TypeError('Invalid password reset document.');
  const result = { ExpirationDate: { ticks: 0n }, Pin: null, UserName: null, PinFile: null };
  for (const [name, node] of root.properties) {
    if (name === 'ExpirationDate') result.ExpirationDate = parseJsonDateTime(node.value);
    else if (['Pin', 'UserName', 'PinFile'].includes(name)) {
      if (node.properties || node.items || node.value !== null && typeof node.value !== 'string') throw new TypeError(`Invalid password reset ${name}.`);
      if (typeof node.value === 'string' && !node.value.isWellFormed()) throw new TypeError(`Invalid password reset ${name}.`);
      result[name] = node.value;
    }
  }
  return result;
}

async function deleteResetFile(filename) {
  await physicalPath(filename);
  if (process.platform === 'win32' && !((await fs.stat(filename)).mode & 0o200)) {
    throw Object.assign(new Error('The password reset file is read-only.'), { code: 'EPERM' });
  }
  await fs.unlink(filename);
}

export class DefaultPasswordResetProvider {
  id = PASSWORD_RESET_PROVIDER;
  name = 'Default Password Reset Provider';
  enabled = true;

  constructor({ users, programDataPath, now = () => new Date() }) {
    if (programDataPath != null && !path.isAbsolute(programDataPath)) throw new TypeError('Password reset storage requires an absolute instance data path.');
    Object.assign(this, { users, programDataPath, now });
  }

  #root() {
    if (!this.programDataPath) throw domainError(501, 'Password reset storage is unavailable.');
    return this.programDataPath;
  }

  async start(user, enteredUsername, isInNetwork) {
    const expiration = wireDate(new Date(this.now().getTime() + 30 * 60_000).toISOString());
    const filename = path.join(this.#root(), prefix + md5Guid(upperInvariant(enteredUsername)) + '.json');
    if (user && isInNetwork) {
      const pin = randomBytes(4).toString('hex').toUpperCase().match(/../gu).join('-');
      await physicalPath(filename, { missing: true });
      await fs.writeFile(filename, JSON.stringify({ Pin: pin, UserName: user.Username, PinFile: filename, ExpirationDate: expiration }));
    }
    return { Action: 'PinCode', PinFile: filename, PinExpirationDate: expiration };
  }

  async redeem(pin) {
    const root = this.#root(), usersReset = [];
    await physicalPath(root);
    const directory = await fs.opendir(root);
    for await (const entry of directory) {
      const name = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
      if (!name.startsWith(prefix) || entry.isDirectory()) continue;
      const filename = path.join(root, entry.name);
      await physicalPath(filename);
      if (!(await fs.stat(filename)).isFile()) continue;
      const reset = readResetFile(await fs.readFile(filename));
      if (reset.ExpirationDate.ticks < currentTicks(this.now)) {
        await deleteResetFile(filename);
      } else if (reset.Pin.replaceAll('-', '') === pin.replaceAll('-', '')) {
        const user = await this.users.getUserByName(reset.UserName);
        if (!user) throw domainError(404, `User with a username of ${reset.UserName} not found`);
        await this.users.changePassword(user.Id, pin);
        usersReset.push(user.Username);
        await deleteResetFile(filename);
      }
    }
    if (!usersReset.length) throw domainError(404, `No Users found with a password reset request matching pin ${pin}`);
    return { Success: true, UsersReset: usersReset };
  }
}

export class PasswordResetService {
  #pending = new Set();
  #closed = false;
  #closing;

  constructor({ users, programDataPath, providers = [], now } = {}) {
    if (!users) throw new TypeError('Password reset requires a user service.');
    this.users = users;
    this.defaultProvider = new DefaultPasswordResetProvider({ users, programDataPath, now });
    this.providers = [this.defaultProvider, ...providers];
    for (const provider of this.providers) {
      if (typeof provider.id !== 'string' || typeof provider.start !== 'function' || typeof provider.redeem !== 'function') {
        throw new TypeError('Password reset providers require identity, start and redemption.');
      }
    }
  }

  #run(operation) {
    if (this.#closed) return Promise.reject(domainError(503, 'Password reset is closed.'));
    const pending = Promise.resolve().then(operation).catch(error => {
      if (error.code === 'ENOENT') error.status = error.statusCode = 404;
      throw error;
    });
    this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }

  start(enteredUsername, isInNetwork) {
    return this.#run(async () => {
      const user = clrTrim(enteredUsername) === '' ? null : await this.users.getUserByName(enteredUsername);
      const available = user ? this.providers.filter(provider => provider.enabled
        && (!user.PasswordResetProviderId || equalsIgnoreCase(provider.id, user.PasswordResetProviderId))) : [];
      const provider = available[0] ?? this.defaultProvider;
      const result = await provider.start(user, enteredUsername, isInNetwork);
      if (user && isInNetwork) await this.users.saveUserSnapshot(user);
      return result;
    });
  }

  redeem(pin) {
    return this.#run(async () => {
      for (const provider of this.providers) {
        const result = await provider.redeem(pin);
        if (result.Success) return result;
      }
      return { Success: false, UsersReset: [] };
    });
  }

  close() {
    this.#closed = true;
    return this.#closing ??= Promise.allSettled([...this.#pending]).then(() => {});
  }
}
