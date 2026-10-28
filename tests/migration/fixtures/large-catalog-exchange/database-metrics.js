import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { PostgresDatabase } from '../../../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier as q } from '../../../../src/database/model.js';
import { errorObservation } from '../../../helpers/error-observation.js';

const statementSubject = text => {
  if (typeof text !== 'string') return 'unknown';
  const command = /^\s*(\w+)/u.exec(text)?.[1]?.toUpperCase() ?? 'unknown';
  if (command === 'CREATE') {
    const index = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+("[^"]+"|\w+)/iu.exec(text);
    return index ? 'INDEX ' + index[1] : command;
  }
  if (['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(command)) {
    const relation = /\b(?:FROM|INTO|UPDATE)\s+(?:"[^"]+"\.)?"([^"]+)"/iu.exec(text);
    return command + (relation ? ' ' + relation[1] : '');
  }
  return command;
};

/** Observe real calls without supplying rows, changing SQL or replacing owners. */
export function observeDatabaseMetrics() {
  const records = [], groups = new Map(), restore = [];
  const primaryKeyPageStatements = new Map(), sqlitePrimaryKeyPageStatements = new Map();
  const statementSubjects = new WeakMap(), statementPrototypes = new Set();
  const sqliteStatementTexts = new WeakMap();
  let phase = 'between-stages';
  const group = (dialect, operation, subject) => {
    const key = [phase, dialect, operation, subject].join('\0');
    if (!groups.has(key)) {
      const entry = { phase, dialect, operation, subject, calls: 0, failures: 0,
        elapsedMilliseconds: 0, maximumMilliseconds: 0, returnedRows: 0, affectedRows: 0,
        inputRows: 0, maximumInputRows: 0, inputCells: 0 };
      groups.set(key, entry); records.push(entry);
    }
    return groups.get(key);
  };
  const finish = (entry, started, value, failed) => {
    const elapsed = performance.now() - started;
    entry.elapsedMilliseconds += elapsed; entry.maximumMilliseconds = Math.max(entry.maximumMilliseconds, elapsed);
    if (failed) entry.failures++;
    else {
      const rows = Array.isArray(value) ? value : value?.rows;
      if (Array.isArray(rows)) entry.returnedRows += rows.length;
      if (typeof value === 'bigint') entry.affectedRows += Number(value);
      else if (typeof value?.changes === 'bigint') entry.affectedRows += Number(value.changes);
      else if (Number.isSafeInteger(value?.rowCount)) entry.affectedRows += value.rowCount;
    }
  };
  const observe = (entry, operation, receiver, argumentsList, input) => {
    const started = performance.now();
    entry.calls++;
    if (input) {
      entry.inputRows += input.rows; entry.maximumInputRows = Math.max(entry.maximumInputRows, input.rows);
      entry.inputCells += input.cells;
    }
    let result;
    try { result = operation.apply(receiver, argumentsList); }
    catch (error) { finish(entry, started, undefined, true); throw error; }
    if (result && typeof result.then === 'function') return result.then(value => {
      finish(entry, started, value, false); return value;
    }, error => { finish(entry, started, undefined, true); throw error; });
    finish(entry, started, result, false); return result;
  };
  for (const owner of [SqliteDatabase, PostgresDatabase]) {
    for (const method of ['rows', 'insertBatch', 'relationRowsInInsertionOrder']) {
      const original = owner.prototype[method];
      owner.prototype[method] = function (...args) {
        // The root insertBatch delegates to an operation session. Count the
        // actual session call once, preserving every physical query below it.
        if (this.dialect === 'postgres' && method === 'insertBatch' && !this.connectionSession) return original.apply(this, args);
        const values = method === 'insertBatch' ? args[1] : null;
        const input = Array.isArray(values) ? { rows: values.length,
          cells: values.length && values[0] ? values.length * Object.keys(values[0]).length : 0 } : undefined;
        return observe(group(this.dialect, method, args[0]), original, this, args, input);
      };
      restore.push(() => { owner.prototype[method] = original; });
    }
  }
  const dispatch = PostgresDatabase.prototype.dispatchOperationQuery;
  PostgresDatabase.prototype.dispatchOperationQuery = function (client, ...args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (phase === 'snapshot-pg-imported' && typeof text === 'string') {
      const name = /\bFROM "(AncestorIds|UserData)"(?: WHERE [\s\S]*?)? ORDER BY /u.exec(text)?.[1];
      if (name) {
        const orderStart = text.lastIndexOf(' ORDER BY '), limitStart = text.indexOf(' LIMIT ', orderStart);
        const expectedOrder = tableDefinition(name).primaryKey.map(key => q(key) + ' ASC').join(', ');
        if (limitStart !== -1 && text.slice(orderStart + 10, limitStart) === expectedOrder) {
          const cursorPage = text.includes(' WHERE ROW('), key = name + ':' + cursorPage;
          if (!primaryKeyPageStatements.has(key)) primaryKeyPageStatements.set(key, {
            phase, table: name, cursorPage, text,
            values: (typeof args[0] === 'string' ? args[1] : args[0]?.values)
              ?.map(value => Buffer.isBuffer(value) ? Buffer.from(value) : value),
            legacyText: text.slice(0, orderStart + 10)
              + tableDefinition(name).primaryKey.map(key => q(key) + ' ASC NULLS FIRST').join(', ') + text.slice(limitStart),
          });
        }
      }
    }
    return observe(group('postgres', 'driver.query', statementSubject(text)), dispatch, this, [client, ...args]);
  };
  restore.push(() => { PostgresDatabase.prototype.dispatchOperationQuery = dispatch; });
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (...args) {
    const subject = statementSubject(args[0]);
    const statement = observe(group('sqlite', 'driver.prepare', subject), prepare, this, args);
    statementSubjects.set(statement, subject);
    sqliteStatementTexts.set(statement, args[0]);
    const prototype = Object.getPrototypeOf(statement);
    if (!statementPrototypes.has(prototype)) {
      statementPrototypes.add(prototype);
      for (const method of ['all', 'get', 'run']) {
        const original = prototype[method];
        prototype[method] = function (...values) {
          const text = sqliteStatementTexts.get(this);
          if (method === 'all' && phase === 'snapshot-native-seeded' && typeof text === 'string') {
            const name = /^SELECT [\s\S]+ FROM "(AncestorIds|UserData)"(?: WHERE [\s\S]*?)? ORDER BY /u.exec(text)?.[1];
            if (name) {
              const orderStart = text.lastIndexOf(' ORDER BY '), limitStart = text.indexOf(' LIMIT ', orderStart);
              const primaryKey = tableDefinition(name).primaryKey;
              const expectedOrder = primaryKey.map(key => `${q(name)}.${q(key)} ASC`).join(', ');
              if (limitStart !== -1 && text.slice(orderStart + 10, limitStart) === expectedOrder) {
                const cursorPage = text.includes(' WHERE ('), key = name + ':' + cursorPage;
                if (!sqlitePrimaryKeyPageStatements.has(key)) sqlitePrimaryKeyPageStatements.set(key, {
                  phase, table: name, cursorPage, text,
                  values: values.map(value => value instanceof Uint8Array ? Buffer.from(value) : value),
                  legacyText: text.slice(0, orderStart + 10) + primaryKey.map(key => q(key) + ' ASC').join(', ') + text.slice(limitStart),
                });
              }
            }
          }
          return observe(group('sqlite', 'driver.' + method, statementSubjects.get(this) ?? 'unclassified'), original, this, values);
        };
        restore.push(() => { prototype[method] = original; });
      }
    }
    return statement;
  };
  restore.push(() => { DatabaseSync.prototype.prepare = prepare; });
  return { records, primaryKeyPageStatements: () => [...primaryKeyPageStatements.values()],
    explainSqlitePrimaryKeyPages(database, { signal } = {}) {
      return [...sqlitePrimaryKeyPageStatements.values()].map(statement => {
        const observation = { diagnosticOnly: true, ...statement };
        for (const [label, text] of [['current', statement.text], ['legacyRawAlias', statement.legacyText]]) {
          try {
            signal?.throwIfAborted();
            // Plain EXPLAIN never replays the historical slow scan or adds a
            // planner-shape requirement to the complete value comparisons.
            const query = database.database.prepare('EXPLAIN QUERY PLAN ' + text); query.setReadBigInts(true);
            observation[label] = query.all(...statement.values);
          } catch (error) { observation[label + 'Error'] = errorObservation(error); }
        }
        return observation;
      });
    }, setPhase: value => { phase = value; }, restore: () => {
    for (const operation of restore.toReversed()) operation();
  } };
}
