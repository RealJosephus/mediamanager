import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresDatabase } from './postgres.js';

const pending = new WeakMap();
const activeLease = new AsyncLocalStorage();

function ownedSession(database) {
  if (!database.connectionSession || !database.connectionActive
    || !database.client.physicalClient) {
    throw new Error('Native query JIT settings require the active owned PostgreSQL operation session.');
  }
  if (database.client.discardedError) throw database.client.discardedError;
  return database.client.physicalClient;
}

async function runLease(database, operation) {
  const read = await database.client.query('/* native-query-jit:read */ SELECT current_setting(\'jit\') AS jit');
  const original = read.rows[0]?.jit;
  if (original !== 'on' && original !== 'off') throw new Error('PostgreSQL returned an invalid JIT setting.');
  const local = Boolean(database.inTransaction);
  let value, failure, failed = false, restorationFailure, restorationFailed = false;
  try {
    // Setting writes can fail after reaching PostgreSQL. Always attempt cleanup
    // after dispatch, including when the disable query itself reports failure.
    const disabled = await database.client.query({
      text: '/* native-query-jit:disable */ SELECT set_config(\'jit\', $1, $2) AS jit',
      values: ['off', local],
    });
    if (disabled.rows[0]?.jit !== 'off') throw new Error('PostgreSQL did not disable JIT for the native query.');
    value = await operation(database);
  } catch (error) { failure = error; failed = true; }
  finally {
    try {
      // The caller's cancellation signal belongs to its business query, not to
      // restoring this connection before the owning operation releases it.
      const restored = await database.client.query({
        text: '/* native-query-jit:restore */ SELECT set_config(\'jit\', $1, $2) AS jit',
        values: [original, local],
      });
      if (restored.rows[0]?.jit !== original) throw new Error('PostgreSQL did not restore the native query JIT setting.');
    } catch (error) {
      // SET LOCAL is automatically rolled back by the existing transaction
      // owner. A failed business statement leaves that transaction in 25P02;
      // do not replace its primary error with this expected cleanup response.
      let abortedTransaction = false;
      try { abortedTransaction = local && failed && error?.code === '25P02'; }
      catch { /* A diagnostic getter cannot replace the actual restore failure. */ }
      if (!abortedTransaction) {
        restorationFailed = true;
        restorationFailure = error;
        database.discardConnection(error instanceof Error ? error
          : new Error('PostgreSQL native query JIT restoration failed.', { cause: error }));
      }
    }
  }
  if (restorationFailed) {
    if (!failed) throw restorationFailure;
    let message = 'PostgreSQL native query JIT restoration failed.';
    try { const value = failure?.message; if (typeof value === 'string') message = value; }
    catch { /* Keep the original primary reason, including hostile getters. */ }
    const aggregate = new AggregateError([failure, restorationFailure], message, { cause: failure });
    for (const name of ['code', 'status', 'statusCode']) {
      try { const value = failure?.[name]; if (value !== undefined) aggregate[name] = value; }
      catch { /* The complete primary reason remains in cause and errors. */ }
    }
    throw aggregate;
  }
  if (failed) throw failure;
  return value;
}

/** Borrow only the owned connection's JIT setting for a native entity query.
 * Both scalar visibility pages and relational live-item frames use this lease. */
export async function withPostgresNativeQueryJitOff(database, operation) {
  if (!(database instanceof PostgresDatabase)) throw new TypeError('Native query JIT settings require PostgreSQL.');
  if (typeof operation !== 'function') throw new TypeError('A native query operation is required.');
  if (!database.connectionSession) {
    return database.withConnection(session => withPostgresNativeQueryJitOff(session, operation));
  }
  const physical = ownedSession(database);
  if (activeLease.getStore() === physical) throw new Error('Native query JIT leases cannot nest on the same PostgreSQL connection.');
  const previous = pending.get(physical) ?? Promise.resolve();
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  pending.set(physical, tail);
  try {
    await previous;
    ownedSession(database);
    return await database.root.operationContext.run(database,
      () => activeLease.run(physical, () => runLease(database, operation)));
  } finally {
    release();
    if (pending.get(physical) === tail) pending.delete(physical);
  }
}
