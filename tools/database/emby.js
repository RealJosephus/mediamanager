import path from 'node:path';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalPortableMountContract } from '../../src/storage/portable-mount-contract.js';
import { exchange, inspectEmby } from '../../src/migration/emby/exchange.js';
import { exists, fileHash, stateDirectory } from '../../src/migration/emby/files.js';
import { companionFiles } from '../../src/migration/intro-skipper.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { embyLibraryMounts, savedMounts } from '../../src/migration/emby/mounts.js';
import { readIdentityMap } from '../../src/migration/emby/identities.js';
import { assetRoots } from '../../src/migration/emby/assets.js';
import { importJellyfinSqlite } from './import-jellyfin.js';
import { exportJellyfinSqlite } from './export-jellyfin.js';
import { reconcileSkipperCopies, snapshotJellyfinAndSkipper } from './intro-skipper-data.js';
import {
  parseNamedOptions,
  closeResources,
  readStableJsonFile,
  readExplicitPostgresUrl,
  readExplicitPostgresSchema,
} from './cli-common.js';

const usage = [
  'emby:inspect -- --source <stopped-Emby-programdata>',
  'emby:import -- --source <stopped-Emby-programdata> --output <new-MediaManager-instance> --schema <new-pg-schema> --postgres-url-env <variable> [--template <stopped-Jellyfin-instance>] [--mount-contract <json>] [--credits-end preserve|runtime] [--admin-user <Emby-name> --admin-password-env <variable>]',
  'emby:export -- --source <MediaManager-instance> --output <new-Emby-programdata> --schema <pg-schema> --postgres-url-env <variable> [--template <stopped-Emby-programdata>]',
  'Both directions accept --identity-map <users/items GUID JSON>, --asset-roots <JSON array of {id,identityRoot,directory}>, --metadata-root <physical source metadata directory> and --template-metadata-root <physical template metadata directory>.',
].join('\n');
export async function runEmby(command, argv, environment = process.env, { afterDatabaseCommit } = {}) {
  if (command === 'inspect') {
    const args = parseNamedOptions(argv, { required: ['--source'] });
    return inspectEmby(args['--source']);
  }
  if (!['import', 'export'].includes(command)) throw new Error(usage);
  const args = parseNamedOptions(argv, {
    required: ['--source', '--output', '--schema'],
    optional: [
      '--postgres-url',
      '--postgres-url-env',
      '--template',
      '--identity-map',
      '--asset-roots',
      '--metadata-root',
      '--template-metadata-root',
      ...(command === 'import' ? ['--mount-contract', '--admin-user', '--admin-password-env', '--credits-end'] : []),
    ],
  });
  const creditsEnd = args['--credits-end'] ?? 'preserve';
  if (!['preserve', 'runtime'].includes(creditsEnd)) throw new Error('--credits-end expects preserve or runtime');
  const connectionString = readExplicitPostgresUrl(args, environment);
  readExplicitPostgresSchema(args);
  const pgarg = args['--postgres-url-env']
    ? ['--postgres-url-env', args['--postgres-url-env']]
    : ['--postgres-url', args['--postgres-url']];
  const common = [...pgarg, '--schema', args['--schema']];
  const envKey = args['--admin-password-env'],
    adminPassword = envKey && environment[envKey];
  if (Boolean(args['--admin-user']) !== Boolean(adminPassword))
    throw new Error(
      'An administrator name and nonempty password environment variable must be supplied together',
    );
  const contract = args['--mount-contract']
    ? (
        await readStableJsonFile(
          args['--mount-contract'],
          'portable mount contract',
          canonicalPortableMountContract,
        )
      ).value
    : undefined;
  return exchange({
    publicationKey: {
      connection: createHash('sha256').update(connectionString).digest('hex'),
      schema: args['--schema'],
      contract,
    },
    afterDatabaseCommit,
    direction: command,
    source: args['--source'],
    output: args['--output'],
    template: args['--template'],
    assetRoots: args['--asset-roots']
      ? (await readStableJsonFile(args['--asset-roots'], 'sidecar roots', assetRoots)).value
      : [],
    metadataRoot: args['--metadata-root'] && path.resolve(args['--metadata-root']),
    templateMetadataRoot: args['--template-metadata-root'] && path.resolve(args['--template-metadata-root']),
    identityMap: args['--identity-map']
      ? (await readStableJsonFile(args['--identity-map'], 'source to target GUID map', readIdentityMap)).value
      : undefined,
    adminUser: args['--admin-user'],
    adminPassword,
    creditsEnd,
    prepareSource:
      command === 'export'
        ? async (root, filename, work) => {
            await mkdir(path.dirname(filename), { recursive: true });
            // This is a private clone. The live database for a MediaManager instance is PostgreSQL.
            for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(filename + suffix, { force: true });
            const skipper = path.join(path.dirname(filename), 'introskipper');
            const postgresSkipper = path.join(work, 'postgres-skipper');
            const db = await PostgresDatabase.open({
              connectionString: readExplicitPostgresUrl(args, environment),
              schema: args['--schema'],
              deferRuntimeSchemaInitialization: true,
            });
            try {
              const binding = await db.readInstanceBinding();
              const id = (await readFile(path.join(root, 'data/data/device.txt'), 'utf8'))
                .replace(/^\uFEFF/u, '')
                .trim();
              if (binding?.serverId !== id)
                throw new Error('PostgreSQL is bound to a different MediaManager instance');
            } finally {
              await db.close();
            }
            const exported = await exportJellyfinSqlite([...common, '--output', filename,
              '--intro-skipper-output', postgresSkipper], { environment });
            const issues = await reconcileSkipperCopies(skipper, postgresSkipper, {
              files: (exported.introSkipperDatabases ?? []).map(name => ({ name })),
              baseline: exported.introSkipperCapture,
            });
            for (const issue of issues)
              issue.evidence.postgresCopy = path.join(stateDirectory, 'origin', 'data/data/introskipper', issue.evidence.postgresCopy);
            await mkdir(path.join(root, 'config'), { recursive: true });
            await writeFile(savedMounts(root), JSON.stringify(exported.portableMountContract), { mode: 0o600 });
            return issues;
          }
        : undefined,
    prepareTarget:
      command === 'import'
        ? async (root, filename, sourceId, targetId, work) => {
            const dir = path.join(root, stateDirectory);
            const binding = path.join(dir, 'binding.json'),
              mounts = path.join(dir, 'mounts.json');
            await writeFile(
              binding,
              JSON.stringify({
                serverId: targetId.slice('jellyfin:'.length),
                originIdentityDigest: createHash('sha256').update(sourceId).digest('hex'),
              }),
              { mode: 0o600 },
            );
            const selected =
              contract ??
              ((await exists(savedMounts(root)))
                ? canonicalPortableMountContract(JSON.parse(await readFile(savedMounts(root), 'utf8')))
                : await embyLibraryMounts(path.join(dir, 'origin')));
            await writeFile(savedMounts(root), JSON.stringify(selected), { mode: 0o600 });
            await writeFile(mounts, JSON.stringify(selected), { mode: 0o600 });
            const { main: snapshot, companions } = await snapshotJellyfinAndSkipper(filename, path.join(path.dirname(filename), 'introskipper'));
            const stable = path.join(work, 'postgres-input.db');
            const skipper = path.join(work, 'postgres-skipper');
            const hashes = {};
            try {
              if (companions.length) await mkdir(skipper, { mode: 0o700 });
              for (const { name, snapshot: file } of [{ name: '', snapshot }, ...companions]) {
                const destination = name ? path.join(skipper, name) : stable;
                await file.assertUnchanged();
                await copyFile(file.filename, destination);
                await file.assertUnchanged();
                hashes[name] = await fileHash(destination);
              }
            } finally {
              const errors = await closeResources([snapshot, ...companions.map(file => file.snapshot)]);
              if (errors.length) throw new AggregateError(errors, 'Could not release prepared database snapshots');
            }
            return hashes;
          }
        : undefined,
    finishTarget:
      command === 'import'
        ? async (root, work, inputHash, resuming) => {
            const filename = path.join(work, 'postgres-input.db'),
              state = path.join(root, stateDirectory);
            // Previously staged imports only sealed the main SQLite snapshot.
            const skipper = typeof inputHash === 'string' ? path.join(root, 'data/data/introskipper') : path.join(work, 'postgres-skipper');
            const hashes = typeof inputHash === 'string' ? { '': inputHash } : inputHash;
            const companions = await companionFiles(skipper);
            const assertUnchanged = async () => {
              if (typeof inputHash !== 'string' && (await companionFiles(skipper)).length !== Object.keys(hashes).length - 1)
                throw new Error('The prepared Intro Skipper database membership changed');
              for (const [name, hash] of Object.entries(hashes))
                if (await fileHash(name ? path.join(skipper, name) : filename) !== hash)
                  throw new Error('The prepared PostgreSQL input changed' + (name ? ': ' + name : ''));
            };
            let reused;
            await importJellyfinSqlite(
              [
                ...common,
                '--source',
                filename,
                '--instance-binding',
                path.join(state, 'binding.json'),
                '--mount-contract',
                path.join(state, 'mounts.json'),
                ...(companions.length ? ['--intro-skipper-data', skipper] : []),
              ],
              {
                environment,
                createSourceSnapshot: async () => ({ filename, assertUnchanged, async close() {} }),
                openPostgres: async (options) => {
                  try {
                    return await PostgresDatabase.open(options);
                  } catch (error) {
                    if (!resuming) throw error;
                    const db = await PostgresDatabase.open({ ...options, create: false });
                    try {
                      const receipt = await db.readTransferReceipt();
                      if (!receipt)
                        throw new Error('Existing PostgreSQL schema has no committed migration receipt');
                      reused = db;
                      return db;
                    } catch (failure) {
                      await db.close();
                      throw failure;
                    }
                  }
                },
                dropTarget: async (db) => {
                  if (db !== reused) await db.dropSchemasCreatedByThisOpen();
                },
              },
            );
          }
        : undefined,
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log(usage);
  else
    try {
      console.log(JSON.stringify(await runEmby(process.argv[2], process.argv.slice(3)), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
