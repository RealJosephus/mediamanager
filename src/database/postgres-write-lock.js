import { setTimeout as delay } from 'node:timers/promises';

const postgresWriteLockPrefix = 'mediamanager:domain-write:';

export async function acquirePostgresWriteLock(database, {
  signal,
  lockRetryMs = 25,
  lockTimeoutMs,
} = {}) {
  if (!Number.isSafeInteger(lockRetryMs) || lockRetryMs < 1) {
    throw new TypeError('lockRetryMs must be a positive integer');
  }
  if (lockTimeoutMs !== undefined && (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1)) {
    throw new TypeError('lockTimeoutMs must be a positive integer');
  }
  const deadline = lockTimeoutMs === undefined ? undefined : Date.now() + lockTimeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const result = await database.client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [`${postgresWriteLockPrefix}${database.schemaName}`]
    );
    if (result.rows[0]?.locked === true) return;
    if (deadline !== undefined && Date.now() >= deadline) {
      const error = new Error('PostgreSQL domain write lock timeout');
      error.code = '55P03';
      throw error;
    }
    const remaining = deadline === undefined ? lockRetryMs : Math.max(1, deadline - Date.now());
    await delay(Math.min(lockRetryMs, remaining), undefined, { signal });
  }
}

export async function releasePostgresWriteLock(database) {
  const result = await database.client.query(
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
    [`${postgresWriteLockPrefix}${database.schemaName}`]
  );
  if (result.rows[0]?.unlocked !== true) throw new Error('PostgreSQL domain write lock was not held');
}
