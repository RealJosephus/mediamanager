import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase } from './database/postgres.js';
import { verifyPostgresTransferContract } from './database/postgres-transfer-contract.js';
import { createRuntime } from './runtime.js';
import { readInstanceConfiguration } from './configuration.js';
import { readMediaEncoderStartupOptions } from './playback/media-encoder.js';
import { readPublishedServerStartupOptions } from './network/startup.js';

function optionalEnvironmentInteger(environment, name, minimum, description) {
  const raw = environment[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(raw)) {
    throw new Error(`${name} must be ${description}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be ${description}.`);
  return value;
}

export function readPostgresPoolOptions(environment) {
  const values = {
    max: optionalEnvironmentInteger(environment, 'MEDIAMANAGER_POSTGRES_POOL_MAX', 1, 'a positive integer'),
    connectionTimeoutMillis: optionalEnvironmentInteger(environment, 'MEDIAMANAGER_POSTGRES_CONNECT_TIMEOUT_MS', 0, 'a non-negative integer'),
    idleTimeoutMillis: optionalEnvironmentInteger(environment, 'MEDIAMANAGER_POSTGRES_IDLE_TIMEOUT_MS', 0, 'a non-negative integer')
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export async function verifyProductionDatabaseContract(database, expectedServerId) {
  const contract = await verifyPostgresTransferContract(database, {
    expectedServerId,
    requirePinnedEnvelope: true,
    requirePortableMountContract: true,
  });
  return contract.portableMountContract;
}

export async function prepareProductionDatabase(database, expectedServerId) {
  const portableMountContract = await verifyProductionDatabaseContract(database, expectedServerId);
  await database.initializeRuntimeSchema();
  return portableMountContract;
}

export async function startProductionInstance({ environment = process.env, args = [], onError = error => console.error(error.message) } = {}) {
  if (environment.MEDIAMANAGER_DATABASE !== undefined) {
    throw new Error('MEDIAMANAGER_DATABASE is no longer supported; the production runtime always uses PostgreSQL.');
  }
  if (typeof environment.MEDIAMANAGER_POSTGRES !== 'string' || !environment.MEDIAMANAGER_POSTGRES.trim()) {
    throw new Error('MEDIAMANAGER_POSTGRES is required for the PostgreSQL runtime.');
  }
  if (typeof environment.MEDIAMANAGER_POSTGRES_SCHEMA !== 'string' || !environment.MEDIAMANAGER_POSTGRES_SCHEMA.trim()) {
    throw new Error('MEDIAMANAGER_POSTGRES_SCHEMA is required for the PostgreSQL runtime.');
  }
  const poolOptions = readPostgresPoolOptions(environment);
  const instance = environment.MEDIAMANAGER_INSTANCE;
  if (!instance) throw new Error('MEDIAMANAGER_INSTANCE must point to a Jellyfin-compatible instance configuration directory.');
  const mediaEncoderOptions = readMediaEncoderStartupOptions({ args, environment });
  const networkStartup = readPublishedServerStartupOptions({ args, environment });
  const settings = await readInstanceConfiguration(instance, { onError });
  const database = await PostgresDatabase.open({
    connectionString: environment.MEDIAMANAGER_POSTGRES,
    schema: environment.MEDIAMANAGER_POSTGRES_SCHEMA,
    deferRuntimeSchemaInitialization: true,
    ...poolOptions
  });
  let portableMountContract;
  try {
    portableMountContract = await prepareProductionDatabase(database, settings.serverId);
  } catch (error) {
    try { await database.close(); }
    catch (closeError) {
      try { await onError(closeError); }
      catch { /* Cleanup reporting must never replace the startup failure. */ }
    }
    throw error;
  }
  let application, closing;
  let databaseOwnedByCaller = true;
  const close = () => closing ??= (async () => {
    const errors = [];
    // Runtime owns admission, scan cancellation and dependency drain as one
    // lifecycle, including configuration saves accepted before shutdown.
    try {
      if (application) await application.close();
      else if (databaseOwnedByCaller) await database.close();
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'The production instance could not close every resource.');
  })();
  try {
    if (!environment.MEDIAMANAGER_STORAGE && portableMountContract.mounts.length) {
      throw new Error('MEDIAMANAGER_STORAGE is required by the persisted portable VFS mount contract.');
    }
    application = await createRuntime({
      ...settings,
      ...networkStartup,
      storageConfiguration: environment.MEDIAMANAGER_STORAGE, environment, portableMountContract,
      mediaEncoderOptions,
      database,
      onError,
      autoDiscoveryOptions: {},
      onDatabaseOwnershipTransferred() { databaseOwnedByCaller = false; }
    });
    await application.start();
    return { ...application, close };
  } catch (error) {
    try { await close(); }
    catch (closeError) {
      try { await onError(closeError); }
      catch { /* Cleanup reporting must never replace the startup failure. */ }
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const application = await startProductionInstance({ args: process.argv.slice(2) });
  for (const listener of application.networkHost.listeners) {
    const address = listener.address.includes(':') ? '[' + listener.address + ']' : listener.address;
    console.log(`MediaManager listening on ${listener.scheme}://${address}:${listener.port}.`);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    application.close().catch(error => { console.error(error.message); process.exitCode = 1; });
  });
}
