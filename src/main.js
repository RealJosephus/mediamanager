import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase } from './database/postgres.js';
import { verifyPostgresTransferContract } from './database/postgres-transfer-contract.js';
import { createRuntime } from './runtime.js';
import { readInstanceConfiguration } from './configuration.js';

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

export async function startProductionInstance({ environment = process.env, onError = error => console.error(error.message) } = {}) {
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
  const port = Number(environment.MEDIAMANAGER_PORT ?? 18396);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MEDIAMANAGER_PORT must be an integer from 0 to 65535.');
  const instance = environment.MEDIAMANAGER_INSTANCE;
  if (!instance) throw new Error('MEDIAMANAGER_INSTANCE must point to a Jellyfin-compatible instance configuration directory.');
  const settings = await readInstanceConfiguration(instance);
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
    // Signal all scan owners together: their serialized queues can be nested,
    // while storage and observers must remain alive until every layer drains.
    await Promise.all([
      Promise.resolve().then(() => application?.tasks?.close()).catch(error => errors.push(error)),
      Promise.resolve().then(() => application?.libraryScanner?.close()).catch(error => errors.push(error)),
      Promise.resolve().then(() => application?.folderScanner?.close()).catch(error => errors.push(error))
    ]);
    // Stop remaining upstream reads so HTTP shutdown cannot wait for an endless media body.
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
      storageConfiguration: environment.MEDIAMANAGER_STORAGE, environment, portableMountContract,
      database,
      onError,
      autoDiscoveryOptions: {
        enabled: settings.configuration.NetworkConfiguration?.AutoDiscovery !== false
      },
      onDatabaseOwnershipTransferred() { databaseOwnedByCaller = false; }
    });
    await new Promise((resolve, reject) => {
      const failed = error => { application.server.off('listening', listening); reject(error); };
      const listening = () => { application.server.off('error', failed); resolve(); };
      application.server.once('error', failed).once('listening', listening).listen(port, '127.0.0.1');
    });
    await application.startAutoDiscovery();
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
  const application = await startProductionInstance();
  console.log(`MediaManager listening on http://127.0.0.1:${application.server.address().port}.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    application.close().catch(error => { console.error(error.message); process.exitCode = 1; });
  });
}
