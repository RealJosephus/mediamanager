import { DatabaseSync, backup as backupSqlite } from 'node:sqlite';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const databaseCliExitCodes = Object.freeze({
  success: 0,
  unexpected: 1,
  usage: 2,
  input: 3,
  compatibility: 4,
  postgres: 5,
  operation: 6,
});

export class DatabaseCliError extends Error {
  constructor(code, message, { exitCode = databaseCliExitCodes.unexpected, cause } = {}) {
    super(message, { cause });
    this.name = 'DatabaseCliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function cliError(code, message, exitCode, cause) {
  return new DatabaseCliError(code, message, { exitCode, cause });
}

export function parseNamedOptions(argv, { required = [], optional = [] } = {}) {
  if (!Array.isArray(argv) || !required.every(name => typeof name === 'string')
    || !optional.every(name => typeof name === 'string')) {
    throw new TypeError('Invalid CLI option specification');
  }
  const allowed = new Set([...required, ...optional]);
  if (allowed.size !== required.length + optional.length) throw new TypeError('Duplicate CLI option specification');
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!allowed.has(name)) {
      throw cliError('USAGE_UNKNOWN_OPTION', `Unknown option: ${String(name)}`, databaseCliExitCodes.usage);
    }
    if (Object.hasOwn(options, name)) {
      throw cliError('USAGE_DUPLICATE_OPTION', `Option may be specified only once: ${name}`, databaseCliExitCodes.usage);
    }
    if (typeof value !== 'string' || !value || value.startsWith('--') || /[\r\n\0]/u.test(value)) {
      throw cliError('USAGE_MISSING_VALUE', `Option requires one non-empty value: ${name}`, databaseCliExitCodes.usage);
    }
    options[name] = value;
  }
  for (const name of required) if (!Object.hasOwn(options, name)) {
    throw cliError('USAGE_MISSING_OPTION', `Required option is missing: ${name}`, databaseCliExitCodes.usage);
  }
  return options;
}

export function readExplicitPostgresUrl(options, environment = process.env) {
  const direct = options['--postgres-url'];
  const environmentName = options['--postgres-url-env'];
  if (Boolean(direct) === Boolean(environmentName)) {
    throw cliError('USAGE_POSTGRES_URL', 'Specify exactly one of --postgres-url or --postgres-url-env.', databaseCliExitCodes.usage);
  }
  if (environmentName && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environmentName)) {
    throw cliError('INPUT_POSTGRES_ENV_NAME', '--postgres-url-env must name one environment variable.', databaseCliExitCodes.input);
  }
  const value = direct ?? environment[environmentName];
  if (typeof value !== 'string' || !value || /[\r\n\0]/u.test(value)) {
    throw cliError('INPUT_POSTGRES_URL', 'The explicit PostgreSQL URL is missing or invalid.', databaseCliExitCodes.input);
  }
  let parsed;
  try { parsed = new URL(value); }
  catch (cause) {
    throw cliError('INPUT_POSTGRES_URL', 'The explicit PostgreSQL URL is invalid.', databaseCliExitCodes.input, cause);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hash
    || !parsed.pathname || parsed.pathname === '/') {
    throw cliError('INPUT_POSTGRES_URL', 'The explicit PostgreSQL URL must use postgres:// or postgresql:// and name a database.', databaseCliExitCodes.input);
  }
  return value;
}

export function readExplicitPostgresSchema(options) {
  const value = options['--schema'];
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(value ?? '')) {
    throw cliError('INPUT_POSTGRES_SCHEMA', '--schema must be an explicit PostgreSQL identifier of at most 40 ASCII characters.', databaseCliExitCodes.input);
  }
  return value;
}

function sameGeneration(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function assertRegularInputFile(filename, label) {
  const resolved = path.resolve(filename);
  let metadata;
  try { metadata = await lstat(resolved, { bigint: true }); }
  catch (cause) {
    throw cliError('INPUT_FILE_UNAVAILABLE', `${label} is unavailable.`, databaseCliExitCodes.input, cause);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw cliError('INPUT_FILE_TYPE', `${label} must be a regular file and not a symbolic link.`, databaseCliExitCodes.input);
  }
  return resolved;
}

async function assertSameRegularFile(filename, expected, label, { generation = false } = {}) {
  let actual;
  try { actual = await lstat(filename, { bigint: true }); }
  catch (cause) { throw new Error(`${label} is unavailable.`, { cause }); }
  if (!actual.isFile() || actual.isSymbolicLink()) throw new Error(`${label} is no longer a regular file.`);
  if (!(generation ? sameGeneration(actual, expected) : sameFile(actual, expected))) {
    throw new Error(`${label} changed identity or contents.`);
  }
  return actual;
}

/**
 * Hold SQLite's write reservation while making a private online-backup snapshot.
 * The returned file is the only database that an import may validate or read.
 */
export async function createLockedSqliteSnapshot(filename, {
  busyTimeoutMs = 10_000,
  backupDatabase = backupSqlite,
  temporaryRoot = os.tmpdir(),
} = {}) {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError('busyTimeoutMs must be a non-negative integer');
  }
  if (typeof backupDatabase !== 'function') throw new TypeError('backupDatabase must be a function');
  if (typeof temporaryRoot !== 'string' || !temporaryRoot) throw new TypeError('temporaryRoot must be a path');
  const source = await assertRegularInputFile(filename, 'SQLite source');
  const sourceIdentity = await lstat(source, { bigint: true });
  const directory = await mkdtemp(path.join(path.resolve(temporaryRoot), 'mediamanager-sqlite-import-'));
  const snapshotFilename = path.join(directory, 'jellyfin.db');
  let barrier, reader, transaction = false, operationError;
  try {
    barrier = new DatabaseSync(source, { enableForeignKeyConstraints: true });
    barrier.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    try {
      barrier.exec('BEGIN IMMEDIATE');
      transaction = true;
    } catch (cause) {
      throw new Error('The SQLite source write barrier could not be acquired; retry from storage that permits a write-reserved migration snapshot.', { cause });
    }
    await assertSameRegularFile(source, sourceIdentity, 'SQLite source');
    reader = new DatabaseSync(source, { readOnly: true, enableForeignKeyConstraints: true });
    await backupDatabase(reader, snapshotFilename);
    reader.close();
    reader = undefined;
    await assertSameRegularFile(source, sourceIdentity, 'SQLite source');
    barrier.exec('ROLLBACK');
    transaction = false;
    barrier.close();
    barrier = undefined;
    const snapshotIdentity = await lstat(snapshotFilename, { bigint: true });
    let closed = false;
    return Object.freeze({
      filename: snapshotFilename,
      source,
      async assertUnchanged() {
        if (closed) throw new Error('The private SQLite import snapshot has already been released.');
        return assertSameRegularFile(snapshotFilename, snapshotIdentity,
          'Private SQLite import snapshot', { generation: true });
      },
      async close() {
        if (closed) return;
        closed = true;
        let integrityError, removalError;
        try {
          await assertSameRegularFile(snapshotFilename, snapshotIdentity,
            'Private SQLite import snapshot', { generation: true });
        } catch (error) { integrityError = error; }
        try { await rm(directory, { recursive: true, force: true }); }
        catch (error) { removalError = error; }
        if (integrityError && removalError) {
          throw new AggregateError([integrityError, removalError],
            'The private SQLite import snapshot changed and could not be removed completely', { cause: integrityError });
        }
        if (integrityError) throw integrityError;
        if (removalError) throw removalError;
      },
    });
  } catch (error) { operationError = error; }
  const cleanupErrors = [];
  if (reader) {
    try { reader.close(); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (transaction) {
    try { barrier.exec('ROLLBACK'); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (barrier) {
    try { barrier.close(); }
    catch (error) { cleanupErrors.push(error); }
  }
  try { await rm(directory, { recursive: true, force: true }); }
  catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    throw new AggregateError([operationError, ...cleanupErrors],
      'SQLite source snapshot creation and cleanup both failed', { cause: operationError });
  }
  throw operationError;
}

export async function readStableJsonFile(filename, label, canonicalize) {
  const resolved = await assertRegularInputFile(filename, label);
  let handle;
  try {
    const named = await lstat(resolved, { bigint: true });
    handle = await open(resolved, 'r');
    const opened = await handle.stat({ bigint: true });
    if (!sameGeneration(named, opened)) throw new Error(`${label} changed identity before it was read.`);
    const text = await handle.readFile('utf8');
    const completed = await handle.stat({ bigint: true });
    const finalNamed = await lstat(resolved, { bigint: true });
    if (!sameGeneration(opened, completed) || !sameGeneration(completed, finalNamed)) {
      throw new Error(`${label} changed while it was being read.`);
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (cause) { throw new Error(`${label} is not valid JSON.`, { cause }); }
    try { return { filename: resolved, value: canonicalize(parsed) }; }
    catch (cause) { throw new Error(`${label} is invalid: ${cause.message}`, { cause }); }
  } catch (cause) {
    throw cliError('INPUT_JSON_INVALID', cause.message, databaseCliExitCodes.input, cause);
  } finally { await handle?.close(); }
}

export async function closeResources(resources) {
  const failures = [];
  for (const resource of resources) if (resource) {
    try { await resource.close(); }
    catch (error) { failures.push(error); }
  }
  return failures;
}

export function combineOperationAndCleanupError(operationError, cleanupErrors, fallbackCode) {
  if (!cleanupErrors.length) return operationError;
  const cleanupMessage = cleanupErrors.map(error => error?.message ?? String(error)).join('; ');
  if (operationError) {
    return cliError(operationError.code ?? fallbackCode,
      `${operationError.message} Resource cleanup also failed: ${cleanupMessage}`,
      operationError.exitCode ?? databaseCliExitCodes.operation,
      new AggregateError([operationError, ...cleanupErrors], operationError.message));
  }
  return cliError(fallbackCode, `Resource cleanup failed: ${cleanupMessage}`,
    databaseCliExitCodes.operation, new AggregateError(cleanupErrors, cleanupMessage));
}

function redactMessage(value) {
  return String(value).replace(/\bpostgres(?:ql)?:\/\/[^\s"']+/giu, 'postgresql://[REDACTED]');
}

export function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry)}\n`);
}

export async function runDatabaseCli({ argv, usage, operation, stdout = process.stdout, stderr = process.stderr }) {
  if (argv.length === 1 && argv[0] === '--help') {
    stdout.write(`${usage.trim()}\n`);
    return databaseCliExitCodes.success;
  }
  try {
    writeJsonLine(stdout, await operation(argv));
    return databaseCliExitCodes.success;
  } catch (error) {
    const normalized = error instanceof DatabaseCliError ? error
      : cliError('UNEXPECTED_FAILURE', error?.message ?? String(error), databaseCliExitCodes.unexpected, error);
    writeJsonLine(stderr, {
      ok: false,
      error: { code: normalized.code, message: redactMessage(normalized.message) },
    });
    return normalized.exitCode;
  }
}
