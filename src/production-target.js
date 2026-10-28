import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectInstanceConfiguration } from './configuration.js';
import { PostgresDatabase } from './database/postgres.js';
import { verifyPostgresTransferContract } from './database/postgres-transfer-contract.js';
import { assertPortableMountStorageConfiguration } from './storage/portable-mount-contract.js';
import { validateStorageConfiguration } from './storage-bootstrap.js';

const selectionNames = ['MEDIAMANAGER_INSTANCE', 'MEDIAMANAGER_POSTGRES_SCHEMA', 'MEDIAMANAGER_STORAGE'];
// A plain spread loses Windows main-thread process.env's case-insensitive
// names. Workers and POSIX retain their native case-sensitive lookup.
const environmentName = name => process.platform === 'win32' && isMainThread ? name.toUpperCase() : name;
const captureEnvironment = environment => Object.fromEntries(Object.entries(environment)
  .map(([name, value]) => [environmentName(name), value]));
const absolutePath = (value, label) => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be an absolute filesystem path.`);
  }
  return path.resolve(value);
};

async function withCleanup(operation, cleanup, message) {
  let value, primary, failed = false;
  try { value = await operation(); }
  catch (error) { primary = error; failed = true; }
  try { await cleanup(); }
  catch (error) {
    if (failed) throw new AggregateError([primary, error], primary?.message ?? message, { cause: primary });
    throw error;
  }
  if (failed) throw primary;
  return value;
}

export function canonicalProductionTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'instancePath,postgresSchema,postgresUrlEnvironment,storageConfigurationPath') {
    throw new TypeError('A production target requires exactly instancePath, postgresSchema, storageConfigurationPath and postgresUrlEnvironment.');
  }
  if (typeof value.postgresSchema !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(value.postgresSchema)) {
    throw new TypeError('Production target postgresSchema must be a PostgreSQL identifier of at most 40 ASCII characters.');
  }
  if (typeof value.postgresUrlEnvironment !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.postgresUrlEnvironment)
    || [...selectionNames, 'MEDIAMANAGER_TARGET', 'MEDIAMANAGER_DATABASE'].includes(environmentName(value.postgresUrlEnvironment))) {
    throw new TypeError('Production target postgresUrlEnvironment must name one connection environment variable.');
  }
  return Object.freeze({ instancePath: absolutePath(value.instancePath, 'Production target instancePath'),
    postgresSchema: value.postgresSchema,
    storageConfigurationPath: value.storageConfigurationPath === null ? null
      : absolutePath(value.storageConfigurationPath, 'Production target storageConfigurationPath'),
    postgresUrlEnvironment: value.postgresUrlEnvironment });
}

export async function readProductionTarget(filename) {
  const file = await open(absolutePath(filename, 'Production target filename'), 'r');
  return withCleanup(async () => {
    if (!(await file.stat()).isFile()) throw new TypeError('Production target must be a regular file.');
    return canonicalProductionTarget(JSON.parse(await file.readFile('utf8')));
  }, () => file.close(), 'Production target read and close failed.');
}

function connectionValue(target, environment) {
  const value = environment[environmentName(target.postgresUrlEnvironment)];
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) {
    throw new Error(`Production target connection environment variable ${target.postgresUrlEnvironment} is required.`);
  }
  return value;
}

/** Resolve one startup selection before any asynchronous instance/database work. */
export async function resolveProductionEnvironment(environment) {
  const captured = captureEnvironment(environment);
  if (captured.MEDIAMANAGER_TARGET === undefined) return captured;
  if (selectionNames.some(name => captured[name] !== undefined)) {
    throw new Error('MEDIAMANAGER_TARGET cannot be combined with direct instance, schema or storage selection.');
  }
  const target = await readProductionTarget(captured.MEDIAMANAGER_TARGET);
  if (captured.MEDIAMANAGER_POSTGRES !== undefined && environmentName(target.postgresUrlEnvironment) !== 'MEDIAMANAGER_POSTGRES') {
    throw new Error('MEDIAMANAGER_TARGET cannot be combined with an unrelated MEDIAMANAGER_POSTGRES connection.');
  }
  delete captured.MEDIAMANAGER_TARGET;
  return { ...captured, MEDIAMANAGER_INSTANCE: target.instancePath, MEDIAMANAGER_POSTGRES_SCHEMA: target.postgresSchema,
    MEDIAMANAGER_POSTGRES: connectionValue(target, captured),
    ...(target.storageConfigurationPath === null ? {} : { MEDIAMANAGER_STORAGE: target.storageConfigurationPath }) };
}

export async function verifyProductionDatabaseContract(database, expectedServerId) {
  const contract = await verifyPostgresTransferContract(database, {
    expectedServerId, requirePinnedEnvelope: true, requirePortableMountContract: true,
  });
  return contract.portableMountContract;
}

/** Publish a verified choice for the next process; existing runtimes retain their owners. */
export async function publishProductionTarget(filename, value, { environment = process.env } = {}) {
  const target = canonicalProductionTarget(value), connectionString = connectionValue(target, captureEnvironment(environment));
  const requested = absolutePath(filename, 'Production target filename');
  const settings = await inspectInstanceConfiguration(target.instancePath);
  const database = await PostgresDatabase.open({ connectionString, schema: target.postgresSchema, deferRuntimeSchemaInitialization: true });
  await withCleanup(async () => {
    const mounts = await verifyProductionDatabaseContract(database, settings.serverId);
    if (target.storageConfigurationPath !== null) {
      const storage = JSON.parse(await readFile(target.storageConfigurationPath, 'utf8'));
      validateStorageConfiguration(storage);
      assertPortableMountStorageConfiguration(mounts, storage);
    } else if (mounts.mounts.length) throw new Error('Production target storage configuration is required by the persisted portable VFS mount contract.');
  }, () => database.close(), 'Production target verification and PostgreSQL close failed.');
  const directory = await realpath(path.dirname(requested)), destination = path.join(directory, path.basename(requested));
  try {
    if (!(await lstat(destination)).isFile()) throw new TypeError('An existing production target must be a regular file.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, '.' + path.basename(destination) + '.' + randomUUID() + '.tmp');
  let created = false;
  await withCleanup(async () => {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    await withCleanup(async () => { await file.writeFile(JSON.stringify(target, null, 2) + '\n'); await file.sync(); },
      () => file.close(), 'Production target write and close failed.');
    // Windows may briefly deny replacement while another process reads the
    // target. Retry the same atomic rename without removing the current file.
    const deadline = performance.now() + 1000;
    for (;;) {
      try { await rename(temporary, destination); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error?.code) || performance.now() >= deadline) throw error;
        await delay(10);
      }
    }
    created = false;
  }, async () => { if (created) await rm(temporary, { force: true }); }, 'Production target publication and temporary-file cleanup failed.');
  return { filename: destination, target };
}
