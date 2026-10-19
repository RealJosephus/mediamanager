import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { tableDefinition } from '../../src/database/model.js';
import { describeFile } from '../validation/inventory.js';
import { assertFreshReferenceOutput, captureReferenceInput, verifyReferenceInput } from './reference-inputs.js';

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) throw new Error('Usage: node tools/compat/prepare-media-reference.mjs EMPTY_INITIALIZER_OUTPUT NEW_MEDIA_FIXTURE_OUTPUT');
const sourceOutput = path.resolve(sourceArgument), outputRoot = path.resolve(destinationArgument);
const source = path.join(sourceOutput, 'instance'), destination = path.join(outputRoot, 'instance');
assertFreshReferenceOutput(outputRoot, [sourceOutput]);
const sourceBefore = await captureReferenceInput(sourceOutput);
const initializationFile = path.join(sourceOutput, 'initialization.json');
const initialization = JSON.parse(await readFile(initializationFile));
if (!initialization.initializedFromEmpty || !initialization.process?.stopped || initialization.process.exitCode !== 0
  || path.resolve(initialization.root ?? '') !== source) {
  throw new Error('A successfully initialized, stopped empty native instance is required.');
}
const originalBytes = await readFile(path.join(source, 'data/data/jellyfin.db'));
const originalHash = createHash('sha256').update(originalBytes).digest('hex');
if (originalHash !== initialization.database.sha256) throw new Error('The source database changed after stopped initialization.');
await mkdir(destination, { recursive: true });
for (const name of ['data', 'config', 'cache', 'log']) {
  await cp(path.join(source, name), path.join(destination, name), { recursive: true, force: false, errorOnExist: true });
}
const replace = text => text.replaceAll(source.replaceAll('\\', '\\\\'), destination.replaceAll('\\', '\\\\'))
  .replaceAll(source, destination).replaceAll(source.replaceAll('\\', '/'), destination.replaceAll('\\', '/'));
async function rebaseConfig(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await rebaseConfig(filename);
    else if (/\.(?:xml|json)$/iu.test(entry.name)) {
      const before = await readFile(filename, 'utf8'), after = replace(before);
      if (before !== after) await writeFile(filename, after);
    }
  }
}
await rebaseConfig(path.join(destination, 'config'));
const database = new SqliteDatabase(path.join(destination, 'data/data/jellyfin.db'), { requireMigrationHistory: true });
const ids = { folder: '11111111-1111-1111-1111-111111111111', movie: '22222222-2222-2222-2222-222222222222' };
try {
  const items = database.rows('BaseItems');
  if (items.some(item => !['PLACEHOLDER', 'MediaBrowser.Controller.Entities.AggregateFolder', 'Emby.Server.Implementations.Playlists.PlaylistsFolder'].includes(item.Type))) {
    throw new Error('The fixture source contains existing media; only the empty initializer output may be seeded.');
  }
  const aggregate = items.find(item => item.Type.endsWith('.AggregateFolder'));
  const device = database.rows('Devices').find(item => item.DeviceId === 'reference-initializer');
  if (!aggregate || !device) throw new Error('Empty native initialization did not retain its root and validation device.');
  const empty = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(column.clrType) ? 0n : 0]));
  const common = { ...empty, DateCreated: '2026-10-03 00:00:00', DateModified: '2026-10-03 00:00:00', DateLastSaved: '2026-10-03 00:00:00',
    ChannelId: '00000000-0000-0000-0000-000000000000', Data: '{}', Genres: '', Tags: '', Studios: '', ProductionLocations: '', TopParentId: ids.folder };
  database.transaction(() => {
    for (const item of items) if (item.Path != null && replace(item.Path) !== item.Path) database.update('BaseItems', { Id: item.Id }, { Path: replace(item.Path) });
    database.update('Devices', { Id: device.Id }, { DeviceId: 'fixture-oracle' });
    database.insert('BaseItems', { ...common, Id: ids.folder, Type: 'MediaBrowser.Controller.Entities.Folder', ParentId: aggregate.Id,
      Name: 'Synthetic Media', CleanName: 'synthetic media', SortName: 'synthetic media', IsFolder: true, MediaType: 'Unknown', UnratedType: 'Other', Path: 'Z:\\SyntheticMedia' });
    database.insert('BaseItems', { ...common, Id: ids.movie, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', ParentId: ids.folder,
      Name: 'Synthetic Movie', CleanName: 'synthetic movie', SortName: 'synthetic movie', IsMovie: true, MediaType: 'Video', UnratedType: 'Movie',
      Path: 'Z:\\SyntheticMedia\\feature.mkv', Data: '{"VideoType":"VideoFile"}' });
    database.insert('AncestorIds', { ItemId: ids.folder, ParentItemId: aggregate.Id });
    database.insert('AncestorIds', { ItemId: ids.movie, ParentItemId: ids.folder });
    database.insert('AncestorIds', { ItemId: ids.movie, ParentItemId: aggregate.Id });
  });
} finally { database.close(); }
await verifyReferenceInput(sourceOutput, sourceBefore);
await writeFile(path.join(outputRoot, 'synthetic-media-fixture.json'), JSON.stringify({ schemaVersion: 1, preparedAt: new Date().toISOString(), source,
  preparation: await describeFile(fileURLToPath(import.meta.url)), initialization: await describeFile(initializationFile),
  originalDatabaseSha256: originalHash, sourceEntriesSha256: sourceBefore.entriesSha256, destination, ids, seededItems: 2, nativeMigrationHistoryRetained: true, sourceUnchanged: true,
  instanceEntriesSha256: (await captureReferenceInput(destination)).entriesSha256,
  credentialsRecorded: false, mediaBytesCreated: false, completeLibraryVerified: false }, null, 2) + '\n');
console.log(JSON.stringify({ output: outputRoot, instance: destination, seededItems: 2, sourceUnchanged: true }));
