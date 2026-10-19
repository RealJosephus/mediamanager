import { AsyncLocalStorage } from 'node:async_hooks';
import { acquirePostgresWriteLock, releasePostgresWriteLock } from './postgres-write-lock.js';

const postgresBackgroundAdmission = Symbol('postgres-background-admission');

async function withPostgresWriteLock(database, scope, operation, options) {
  if (scope.writeLockDepth > 0) return operation();
  await acquirePostgresWriteLock(database, options);
  scope.writeLockDepth += 1;
  let result, operationError;
  try { result = await operation(); }
  catch (error) { operationError = error; }
  finally { scope.writeLockDepth -= 1; }
  try { await releasePostgresWriteLock(database); }
  catch (releaseError) {
    database.discardConnection(releaseError);
    if (operationError) {
      throw new AggregateError([operationError, releaseError], operationError.message, { cause: operationError });
    }
    throw releaseError;
  }
  if (operationError) throw operationError;
  return result;
}

export class DomainStore {
  #postgresBackgroundTail = Promise.resolve();
  #context = new AsyncLocalStorage();
  #activePostgres = new Set();
  #closing = false;
  #closePromise;

  constructor(database) {
    if (!database || database.dialect !== 'postgres' || typeof database.withConnection !== 'function') {
      throw new TypeError('A pooled PostgreSQL database is required.');
    }
    this.database = database;
  }

  run(operation, {
    signal,
    readOnly = false,
    lockTimeoutMs,
    [postgresBackgroundAdmission]: backgroundAdmitted = false
  } = {}) {
    const inherited = this.#context.getStore();
    if (inherited?.active) {
      return Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return operation(inherited.database);
      });
    }
    if (this.#closing && !backgroundAdmitted) return Promise.reject(new Error('Database store is closing'));
    const start = () => this.database.withConnection(database => {
      signal?.throwIfAborted();
      let finishScope;
      const finished = new Promise(resolve => { finishScope = resolve; });
      const scope = { active: true, transaction: false, writeLockDepth: 0, database, finished };
      return this.#context.run(scope, async () => {
        try {
          if (readOnly) {
            scope.transaction = true;
            try {
              return await database.transaction(operation, {
                readOnly: true,
                isolation: 'read-committed',
                signal,
                lockTimeoutMs
              });
            } finally { scope.transaction = false; }
          }
          return await operation(database);
        } finally {
          scope.active = false;
          finishScope();
        }
      });
    });
    const task = backgroundAdmitted ? Promise.resolve().then(start)
      : this.#postgresBackgroundTail.then(start);
    this.#activePostgres.add(task);
    void task.finally(() => this.#activePostgres.delete(task)).catch(() => {});
    return task;
  }

  transaction(operation, options = {}) {
    return this.run(async (database) => {
      const scope = this.#context.getStore();
      if (scope.transaction) throw new Error('Nested domain transactions are not supported.');
      scope.transaction = true;
      try {
        return await withPostgresWriteLock(database, scope,
          () => database.transaction(operation, options), options);
      } finally { scope.transaction = false; }
    }, { signal: options.signal });
  }

  // Some native save flows intentionally span more than one database
  // transaction. Keep those phases on one connection under the same
  // cross-process PostgreSQL writer lock so another runtime cannot interleave.
  serializeWrites(operation, options = {}) {
    return this.run(database => withPostgresWriteLock(database, this.#context.getStore(),
      () => operation(database), options), { signal: options.signal });
  }

  // Persistence helpers may be used either as top-level operations or from a
  // service that already owns the complete multi-phase writer boundary. Avoid
  // claiming a second boundary in the latter case while retaining standalone
  // cross-process serialization for PostgreSQL.
  ensureSerializedWrites(operation, options = {}) {
    const scope = this.#context.getStore();
    if (scope?.active && scope.writeLockDepth > 0) {
      return Promise.resolve().then(() => {
        options.signal?.throwIfAborted();
        return operation(scope.database);
      });
    }
    return this.serializeWrites(operation, options);
  }

  // Background work must join the connection queue, not inherit an active
  // request's reentrant scope and run concurrently with that request.
  enqueue(operation, options = {}) {
    const inherited = this.#context.getStore();
    return this.#context.exit(() => {
      if (this.#closing && !inherited?.active) return Promise.reject(new Error('Database store is closing'));
      const predecessor = this.#postgresBackgroundTail;
      const originFinished = inherited?.active && inherited.finished ? inherited.finished : Promise.resolve();
      const task = predecessor.then(() => originFinished)
        .then(() => this.run(operation, {
          ...options,
          [postgresBackgroundAdmission]: true
        }));
      this.#postgresBackgroundTail = task.catch(() => {});
      this.#activePostgres.add(task);
      void task.finally(() => this.#activePostgres.delete(task)).catch(() => {});
      return task;
    });
  }

  // A service-owned background operation can wait on timers or remote work
  // without reserving a database connection or blocking later requests.
  // Its individual SQL operations acquire their own ordinary store scopes.
  runDetached(operation) { return this.#context.exit(operation); }

  async close() {
    if (this.#context.getStore()?.active) throw new Error('Cannot close a DomainStore from an active operation');
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      while (this.#activePostgres.size) {
        await Promise.allSettled([...this.#activePostgres]);
      }
      return this.database.close();
    })();
    return this.#closePromise;
  }
}
