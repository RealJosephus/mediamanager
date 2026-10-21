import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresDatabase } from './postgres.js';

const pending = new WeakMap();
const activeLease = new AsyncLocalStorage();

function ownedSession(database) {
  if (!database.connectionSession || !database.connectionActive
    || database.root.operationContext.getStore() !== database
    || !database.client.physicalClient) {
    throw new Error('Native visibility JIT settings require the active owned PostgreSQL operation session.');
  }
  if (database.client.discardedError) throw database.client.discardedError;
  return database.client.physicalClient;
}

async function runLease(database, operation) {
  const read = await database.client.query('/* native-visibility-jit:read */ SELECT current_setting(\'jit\') AS jit');
  const original = read.rows[0]?.jit;
  if (original !== 'on' && original !== 'off') throw new Error('PostgreSQL returned an invalid JIT setting.');
  const local = Boolean(database.inTransaction);
  let value, failure, failed = false, restorationFailure;
  try {
    // Setting writes can fail after reaching PostgreSQL. Always attempt cleanup
    // after dispatch, including when the disable query itself reports failure.
    const disabled = await database.client.query({
      text: '/* native-visibility-jit:disable */ SELECT set_config(\'jit\', $1, $2) AS jit',
      values: ['off', local],
    });
    if (disabled.rows[0]?.jit !== 'off') throw new Error('PostgreSQL did not disable JIT for the native visibility query.');
    value = await operation(database);
  } catch (error) { failure = error; failed = true; }
  finally {
    try {
      // The caller's cancellation signal belongs to its business query, not to
      // restoring this connection before the owning operation releases it.
      const restored = await database.client.query({
        text: '/* native-visibility-jit:restore */ SELECT set_config(\'jit\', $1, $2) AS jit',
        values: [original, local],
      });
      if (restored.rows[0]?.jit !== original) throw new Error('PostgreSQL did not restore the native visibility JIT setting.');
    } catch (error) {
      // SET LOCAL is automatically rolled back by the existing transaction
      // owner. A failed business statement leaves that transaction in 25P02;
      // do not replace its primary error with this expected cleanup response.
      if (!(local && failed && error?.code === '25P02')) {
        restorationFailure = error;
        database.discardConnection(error);
      }
    }
  }
  if (restorationFailure) {
    throw new AggregateError(failed ? [failure, restorationFailure] : [restorationFailure],
      failed && typeof failure?.message === 'string' ? failure.message : 'PostgreSQL native visibility JIT restoration failed.',
      { cause: failed ? failure : restorationFailure });
  }
  if (failed) throw failure;
  return value;
}

/** Only a bounded scalar visibility projection may borrow a connection's JIT setting. */
export async function withPostgresNativeVisibilityJitOff(database, projectionCount, operation) {
  if (!(database instanceof PostgresDatabase)) throw new TypeError('Native visibility JIT settings require PostgreSQL.');
  if (!Number.isSafeInteger(projectionCount) || projectionCount < 1 || projectionCount > 128) {
    throw new TypeError('Native visibility projections must contain between 1 and 128 items.');
  }
  if (typeof operation !== 'function') throw new TypeError('A native visibility query operation is required.');
  if (!database.connectionSession) {
    return database.withConnection(session => withPostgresNativeVisibilityJitOff(session, projectionCount, operation));
  }
  const physical = ownedSession(database);
  if (activeLease.getStore() === physical) throw new Error('Native visibility JIT leases cannot nest on the same PostgreSQL connection.');
  const previous = pending.get(physical) ?? Promise.resolve();
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  pending.set(physical, tail);
  try {
    await previous;
    ownedSession(database);
    return await activeLease.run(physical, () => runLease(database, operation));
  } finally {
    release();
    if (pending.get(physical) === tail) pending.delete(physical);
  }
}
