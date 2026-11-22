import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { canonicalNativeSqliteSchema } from '../../database/sqlite-schema.js';
import { pinnedNativeSqliteMigrationHistory } from '../../database/native-envelope.js';
import { nativeGuid } from '../../users/native.js';
import { embyCatalog, jellyfinCatalog, schemaColumns } from './catalog.js';
import { changesBetween } from './reconcile.js';
import { activeSystemRoots, alignIdentities, translatedRows } from './identities.js';
import { writeJellyfin } from './write-jellyfin.js';
import { writeEmby } from './write-emby.js';
import { openPublication } from './publication.js';
import { originCoverage } from './coverage.js';
import { readJellyfinLibraryOptions, writeJellyfinLibraryOptions } from './libraries.js';
import { activateMetadata, collectAssets, libraryRoot, metadataDirectory, projectAssetRows } from './assets.js';
import {
  directory,
  exists,
  inside,
  stateDirectory,
  cloneDirectory,
  verifyState,
  sealState,
  mergeAssets,
  writeJson,
} from './files.js';
import { fromBlob } from './format.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const jellyDb = (root) => path.join(root, 'data', 'data', 'jellyfin.db');

function verifyDb(db, schemas) {
  for (const schema of schemas) {
    const integrity = db.prepare('PRAGMA ' + schema + '.integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
      throw new Error(schema + ' integrity check failed: ' + JSON.stringify(integrity));
    if (db.prepare('PRAGMA ' + schema + '.foreign_key_check').get())
      throw new Error(schema + ' contains foreign key violations');
  }
}
function connect(root, type, readOnly) {
  const filename = type === 'emby' ? path.join(root, 'data', 'library.db') : jellyDb(root);
  const db = new DatabaseSync(filename, { readOnly, allowExtension: false, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF');
    if (type === 'emby') db.prepare('ATTACH DATABASE ? AS accounts').run(path.join(root, 'data', 'users.db'));
    if (readOnly) db.exec('PRAGMA query_only=ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
async function identity(root, type, db) {
  const candidates =
    type === 'emby'
      ? [path.join(root, 'data', 'device.txt'), path.join(root, 'device.txt')]
      : [path.join(root, 'data', 'data', 'device.txt')];
  for (const file of candidates)
    if (await exists(file)) {
      const value = (await readFile(file, 'utf8')).replace(/^\uFEFF/u, '').trim();
      if (value) return type + ':' + value;
    }
  if (type === 'emby') {
    const row = db
      .prepare('SELECT guid FROM MediaItems WHERE type=1 AND guid IS NOT NULL ORDER BY Id LIMIT 1')
      .get();
    if (row) return 'emby:' + fromBlob(row.guid, '').replaceAll('-', '').toLowerCase();
  }
  throw new Error('The stopped ' + type + ' instance has no stable identity.');
}
async function assertInput(root, type) {
  const names =
    type === 'emby' ? [path.join(root, 'data/library.db'), path.join(root, 'data/users.db')] : [jellyDb(root)];
  for (const name of names) {
    const info = await lstat(name);
    if (!info.isFile() || info.isSymbolicLink() || !info.size)
      throw new Error('Expected a populated ordinary SQLite database: ' + name);
  }
}
async function createJellyfin(root, srcIdentity) {
  await mkdir(path.join(root, 'data/data'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'config'), { mode: 0o700 });
  const id = nativeGuid(digest(srcIdentity).slice(0, 32)).replaceAll('-', '').toLowerCase();
  await writeFile(path.join(root, 'data/data/device.txt'), id, { mode: 0o600 });
  const db = new DatabaseSync(jellyDb(root));
  try {
    for (const ddl of canonicalNativeSqliteSchema().ddl.sort(
      (a, b) => Number(!a.startsWith('CREATE TABLE')) - Number(!b.startsWith('CREATE TABLE')),
    ))
      db.exec(ddl);
    const put = db.prepare('INSERT INTO __EFMigrationsHistory VALUES(?,?)');
    db.exec('BEGIN');
    for (const { MigrationId, ProductVersion } of pinnedNativeSqliteMigrationHistory)
      put.run(MigrationId, ProductVersion);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}
const silent = () => {};
function getCatalog(type, db, id, report) {
  return type === 'emby' ? embyCatalog(db, id, report) : jellyfinCatalog(db, report);
}
export async function inspectEmby(root) {
  root = await directory(root);
  await assertInput(root, 'emby');
  const db = connect(root, 'emby', true);
  try {
    verifyDb(db, ['main', 'accounts']);
    const id = await identity(root, 'emby', db),
      counts = {};
    for (const name of ['MediaItems', 'UserDatas', 'ListItems', 'Chapters3', 'MediaStreams2', 'ItemPeople2'])
      counts[name] = db.prepare('SELECT count(*) AS n FROM ' + name).get().n;
    counts.users = db.prepare('SELECT count(*) AS n FROM accounts.LocalUsersv2').get().n;
    const catalog = embyCatalog(db, id, silent);
    return {
      identity: id,
      counts,
      mappedRecords: catalog.rows.size,
      hasDateLastSearched: schemaColumns(db, 'UserDatas').has('DateLastSearchedInt'),
      retainedSourceColumns: originCoverage(db),
    };
  } finally {
    db.close();
  }
}

export async function exchange({
  direction,
  source,
  output,
  template,
  identityMap,
  assetRoots = [],
  metadataRoot,
  templateMetadataRoot,
  prepareSource,
  publicationKey,
  prepareTarget,
  finishTarget,
  afterDatabaseCommit,
  adminUser,
  adminPassword,
}) {
  const sourceType = direction === 'import' ? 'emby' : 'jellyfin',
    targetType = direction === 'import' ? 'jellyfin' : 'emby';
  source = await directory(source);
  output = path.resolve(output);
  await directory(path.dirname(output));
  if (inside(source, output) || inside(output, source)) throw new Error('Source and output must be disjoint');
  if (template) {
    template = await directory(template);
    if (inside(template, output) || inside(output, template)) throw new Error('Template and output overlap');
  }
  const publication = await openPublication(output, {
    direction,
    source,
    template,
    identityMap,
    assetRoots,
    metadataRoot,
    templateMetadataRoot,
    adminUser,
    publicationKey,
  });
  const work = publication.build,
    target = publication.target,
    captured = path.join(work, 'source');
  let success = false;
  async function publish(pending, resuming) {
    const already = resuming && (await publication.validate(pending));
    if (!already) {
      if (finishTarget) await finishTarget(target, work, pending.inputHash, resuming);
      if (afterDatabaseCommit) await afterDatabaseCommit();
      await publication.publish();
    }
    success = true;
    return pending.result;
  }
  try {
    if (publication.pending) return await publish(publication.pending, true);
    const prior = await verifyState(source, sourceType);
    await cloneDirectory(source, captured, { skipState: true });
    if (prepareSource) await prepareSource(captured, jellyDb(captured));
    await assertInput(captured, sourceType);
    const sourceDb = connect(captured, sourceType, true);
    let sourceId,
      targetId,
      sourceView,
      targetView,
      baseline,
      aliases,
      stats,
      inputAssets,
      pathMaps,
      retainedSourceColumns,
      issues = [];
    const report = (status, kind, id, field, reason) => issues.push({ status, kind, id, field, reason });
    try {
      inputAssets = await collectAssets({
        instance: captured,
        original: source,
        type: sourceType,
        stage: path.join(work, 'input-metadata'),
        override: metadataRoot,
        roots: assetRoots,
        report,
      });
      verifyDb(sourceDb, sourceType === 'emby' ? ['main', 'accounts'] : ['main']);
      if (sourceType === 'emby') retainedSourceColumns = originCoverage(sourceDb);
      sourceId = await identity(captured, sourceType, sourceDb);
      const seed = template ?? prior?.origin;
      if (seed) await cloneDirectory(seed, target, { skipState: true });
      else if (targetType === 'jellyfin') await createJellyfin(target, sourceId);
      else
        throw new Error(
          'Supply --template with a stopped official Emby program-data directory for a first export.',
        );
      await assertInput(target, targetType);
      const seedAssets = await collectAssets({
        instance: target,
        original: seed ?? target,
        type: targetType,
        stage: path.join(work, 'template-metadata'),
        override: template ? templateMetadataRoot : prior?.external,
        roots: [],
        report,
      });
      await activateMetadata(target, targetType, seedAssets.directory, path.join(work, 'inactive-metadata'));
      seedAssets.directory = metadataDirectory(target, targetType);
      const targetDb = connect(target, targetType, false);
      try {
        verifyDb(targetDb, targetType === 'emby' ? ['main', 'accounts'] : ['main']);
        targetId = await identity(target, targetType, targetDb);
        baseline = prior && prior.originIdentity === targetId ? prior.base : null;
        const targetLibrary = targetType === 'emby' ? '%RootFolderPath%' : libraryRoot(output, targetType);
        inputAssets.targetLibrary = seedAssets.targetLibrary = targetLibrary;
        inputAssets.libraryRoots = [
          libraryRoot(source, sourceType),
          ...(baseline?.assets?.libraryRoots?.target ?? []),
        ];
        seedAssets.libraryRoots = [
          libraryRoot(seed ?? target, targetType),
          ...(baseline?.assets?.libraryRoots?.source ?? []),
        ];
        sourceView = getCatalog(sourceType, sourceDb, sourceId, report);
        targetView = getCatalog(targetType, targetDb, targetId, silent);
        if (sourceType === 'jellyfin') await readJellyfinLibraryOptions(sourceView, captured);
        if (targetType === 'jellyfin') await readJellyfinLibraryOptions(targetView, target);
        const transferable =
          sourceType === 'jellyfin' ? activeSystemRoots(sourceView.rows, report) : sourceView.rows;
        aliases = alignIdentities(
          transferable,
          targetView.rows,
          baseline?.aliases,
          identityMap,
          !seed && targetType === 'jellyfin' ? output : null,
        );
        const sourceAssets = await projectAssetRows(
          transferable,
          inputAssets,
          report,
          baseline?.assets?.paths?.target,
        );
        const targetAssets = await projectAssetRows(
          targetView.rows,
          seedAssets,
          silent,
          baseline?.assets?.paths?.source,
        );
        const oldSource = new Map(baseline?.target);
        const beforeSource = await projectAssetRows(
          sourceType === 'jellyfin' ? activeSystemRoots(oldSource, silent) : oldSource,
          inputAssets,
          silent,
          sourceAssets.paths,
        );
        const beforeTarget = await projectAssetRows(
          new Map(baseline?.source),
          seedAssets,
          silent,
          targetAssets.paths,
        );
        pathMaps = { source: sourceAssets.paths, target: targetAssets.paths };
        const aligned = {
          ...sourceView,
          ambiguous: new Map(
            [...(sourceView.ambiguous ?? [])].map(([key, names]) => {
              const [, item, user] = key.split('/');
              return [['play', aliases.items[item] ?? item, aliases.users[user] ?? user].join('/'), names];
            }),
          ),
          rows: translatedRows(sourceAssets.rows, aliases, targetAssets.rows, !baseline),
          users: new Map([...sourceView.users].map(([id, row]) => [aliases.users[id] ?? id, row])),
        };
        const changes = changesBetween(
          aligned.rows,
          targetAssets.rows,
          translatedRows(beforeSource.rows, aliases, targetAssets.rows, false),
          beforeTarget.rows,
          report,
        );
        targetDb.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
        try {
          const writes = [...targetAssets.changes, ...changes];
          if (targetType === 'emby') await writeEmby(targetDb, writes, targetView, aligned, report, target);
          else {
            await writeJellyfin(targetDb, writes, targetView, aligned, report, {
              adminUser,
              adminPassword,
            });
            await writeJellyfinLibraryOptions(writes, target);
          }
          verifyDb(targetDb, targetType === 'emby' ? ['main', 'accounts'] : ['main']);
          targetDb.exec('COMMIT');
        } catch (error) {
          targetDb.exec('ROLLBACK');
          throw error;
        }
        targetView = getCatalog(targetType, targetDb, targetId, silent);
        if (targetType === 'jellyfin') await readJellyfinLibraryOptions(targetView, target);
        stats = {
          sourceRecords: sourceView.rows.size,
          targetRecords: targetView.rows.size,
          changes: changes.length,
        };
      } finally {
        targetDb.close();
      }
    } finally {
      sourceDb.close();
    }
    const assets = await mergeAssets(
      inputAssets.directory,
      metadataDirectory(target, targetType),
      baseline?.assets?.target,
      baseline?.assets?.source,
      report,
    );
    const libraries = (root, type) => path.join(root, type === 'emby' ? '' : 'data', 'root', 'default');
    assets.libraries = await mergeAssets(
      libraries(captured, sourceType),
      libraries(target, targetType),
      baseline?.assets?.libraries?.target,
      baseline?.assets?.libraries?.source,
      report,
    );
    assets.paths = pathMaps;
    assets.libraryRoots = { source: inputAssets.libraryRoots, target: [libraryRoot(output, targetType)] };
    await sealState(
      target,
      targetType,
      captured,
      sourceId,
      sourceView.rows,
      targetView.rows,
      assets,
      aliases,
      inputAssets.extra ? inputAssets.directory : null,
    );
    // Copying and hashing the origin precedes the PG commit. A rename failure
    // after that point leaves a complete, identifiable directory for recovery.
    await writeJson(path.join(target, stateDirectory, 'report.json'), {
      direction,
      sourceId,
      targetId,
      retainedSourceColumns,
      ...stats,
      issues,
    });
    const inputHash = prepareTarget
      ? await prepareTarget(target, jellyDb(target), sourceId, targetId, work)
      : null;
    const result = {
      output,
      ...stats,
      issues: issues.length,
      conflicts: issues.filter((i) => i.status === 'conflict').length,
      report: path.join(output, stateDirectory, 'report.json'),
    };
    return await publish(await publication.ready(result, inputHash), false);
  } finally {
    await publication.close(success);
  }
}
