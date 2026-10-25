import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';

export async function createObservationJournal(filename, { secrets = new Set(), scope }) {
  await writeFile(filename, JSON.stringify({ scope, diagnosticOnly: true }) + '\n', { flag: 'wx' });
  let writes = Promise.resolve();
  return {
    record(value) {
      const line = JSON.stringify(JSON.parse(filterEvidenceJson({ at: new Date().toISOString(), ...value }, secrets))) + '\n';
      writes = writes.then(() => appendFile(filename, line));
      writes.catch(() => {});
    },
    close: () => writes,
  };
}

/** Observe public physical queries without replacing their SQL or arguments. */
export function observePostgresQueries(database, journal, context = () => ({})) {
  const clients = new Map(), statements = new Set();
  let ordinal = 0;
  const acquire = client => {
    if (clients.has(client)) return;
    const original = client.query;
    function query(...args) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      const statement = typeof sql === 'string' ? createHash('sha256').update(sql).digest('hex') : null;
      if (statement && !statements.has(statement)) { statements.add(statement); journal.record({ kind: 'sql-statement', statement, sql }); }
      const observation = { kind: 'sql-query', ordinal: ++ordinal, statement, ...context() }, started = performance.now();
      journal.record({ ...observation, phase: 'started' });
      const finish = (result, error) => journal.record({ ...observation, phase: 'settled', durationMs: performance.now() - started,
        rowCount: result?.rowCount, rows: result?.rows?.length,
        error: error && { name: error.name, code: error.code, message: error.message } });
      let pending;
      try { pending = original.apply(this, args); }
      catch (error) { finish(null, error); throw error; }
      if (typeof pending?.then !== 'function') { journal.record({ ...observation, phase: 'completion-not-observed' }); return pending; }
      return pending.then(result => { finish(result); return result; }, error => { finish(null, error); throw error; });
    }
    clients.set(client, { original, query }); client.query = query;
  };
  database.pool.on('acquire', acquire);
  return () => {
    database.pool.off('acquire', acquire);
    for (const [client, { original, query }] of clients) if (client.query === query) client.query = original;
    clients.clear();
  };
}
