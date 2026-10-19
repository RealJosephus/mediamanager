import { randomUUID } from 'node:crypto';
import { domainError, nativeDate, wireDate } from './native.js';

export class ApiKeyService {
  #pending = new Set();
  #closed = false;
  #closing;

  constructor({ store, now = () => new Date() } = {}) {
    if (!store) throw new TypeError('API keys require a PostgreSQL store.');
    Object.assign(this, { store, now });
  }

  #run(operation) {
    if (this.#closed) return Promise.reject(domainError(503, 'API keys are closed.'));
    const pending = this.store.run(operation);
    this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }

  list() {
    return this.#run(database => database.transaction(async database => {
      const items = [];
      let after;
      while (true) {
        const rows = await database.rows('ApiKeys', {
          columns: ['Id', 'AccessToken', 'Name', 'DateCreated'], limit: 128, ...(after && { after })
        });
        for (const key of rows) items.push({ Id: 0, AccessToken: key.AccessToken, DeviceId: '', AppName: key.Name,
          AppVersion: '', DeviceName: '', UserId: '00000000000000000000000000000000', IsActive: false,
          DateCreated: wireDate(key.DateCreated), DateLastActivity: '0001-01-01T00:00:00.0000000Z' });
        if (rows.length < 128) return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
        after = { Id: rows.at(-1).Id };
      }
    }, { readOnly: true, isolation: 'repeatable-read' }));
  }

  create(name) {
    return this.#run(() => this.store.transaction(database => database.insert('ApiKeys', {
      Name: name, AccessToken: randomUUID().replaceAll('-', ''),
      DateCreated: nativeDate(this.now()), DateLastActivity: '0001-01-01 00:00:00'
    })));
  }

  revoke(token) {
    return this.#run(() => this.store.transaction(database => database.deleteWhere('ApiKeys', { AccessToken: token })));
  }

  close() {
    this.#closed = true;
    return this.#closing ??= Promise.allSettled([...this.#pending]).then(() => {});
  }
}
