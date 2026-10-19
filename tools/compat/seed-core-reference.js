import { validationPath } from '../validation/paths.js';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel } from '../../src/database/model.js';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('An isolated scenario directory is required.');
const root = path.resolve(directory);
const allowed = validationPath(path.resolve('.agent-docs/evidence')) + path.sep;
if (!root.startsWith(allowed)) throw new Error('This fixture tool only writes isolated evidence directories.');
const oldRoot = validationPath(path.resolve('.agent-docs/reference-instance'));
const instance = validationPath(path.join(root, 'reference'));
const replacePaths = (text) => text.replaceAll(oldRoot.replaceAll('\\', '\\\\'), instance.replaceAll('\\', '\\\\')).replaceAll(oldRoot, instance).replaceAll(oldRoot.replaceAll('\\', '/'), instance.replaceAll('\\', '/'));
async function rebaseFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await rebaseFiles(filename);
    else if (/\.(?:xml|json)$/i.test(entry.name)) {
      const before = await readFile(filename, 'utf8');
      const after = replacePaths(before);
      if (after !== before) await writeFile(filename, after);
    }
  }
}
await rebaseFiles(path.join(instance, 'config'));
const db = new SqliteDatabase(path.join(instance, 'data/data/jellyfin.db'), { requireMigrationHistory: true });
const ids = { folder: '11111111-1111-1111-1111-111111111111', movie: '22222222-2222-2222-2222-222222222222', other: '33333333-3333-3333-3333-333333333333' };
db.transaction(() => {
  for (const table of nativeModel.tables) for (const row of db.rows(table.name)) {
    const changes = Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value === 'string' && replacePaths(value) !== value).map(([key, value]) => [key, replacePaths(value)]));
    if (Object.keys(changes).length) db.update(table.name, Object.fromEntries(table.primaryKey.map((key) => [key, row[key]])), changes);
  }
  const aggregate = db.rows('BaseItems').find((row) => row.Type.endsWith('.AggregateFolder'));
  const table = nativeModel.tables.find((table) => table.name === 'BaseItems');
  const empty = Object.fromEntries(table.columns.map((column) => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : 0]));
  const common = { ...empty, DateCreated: '2026-09-20 12:00:00', DateModified: '2026-09-20 12:00:00', DateLastSaved: '2026-09-20 12:00:00', ChannelId: '00000000-0000-0000-0000-000000000000', Genres: '', Tags: '', Studios: '', ProductionLocations: '', TopParentId: ids.folder, Width: 0, Height: 0 };
  db.insert('BaseItems', { ...common, Id: ids.folder, Type: 'MediaBrowser.Controller.Entities.Folder', ParentId: aggregate.Id, Name: 'Core Flow Movies', CleanName: 'core flow movies', SortName: 'core flow movies', Path: 'Z:\\CoreFlow\\Movies', IsFolder: true, MediaType: 'Unknown', UnratedType: 'Other', Data: '{}' });
  for (const [id, name, sort, year, rating] of [[ids.movie, 'Alpha 中文', 'alpha 中文', 2020, 7.5], [ids.other, 'Beta Film', 'beta film', 2024, 8.1]]) {
    db.insert('BaseItems', { ...common, Id: id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', ParentId: ids.folder, Name: name, CleanName: sort, SortName: sort, Path: `Z:\\CoreFlow\\Movies\\${name}.mkv`, IsMovie: true, MediaType: 'Video', UnratedType: 'Movie', RunTimeTicks: 72000000000n, ProductionYear: year, CommunityRating: rating, Overview: `${name} overview`, Genres: 'Drama', Data: '{"VideoType":"VideoFile","IsHD":false,"IsShortcut":false,"RemoteTrailers":[]}' });
    db.insert('AncestorIds', { ItemId: id, ParentItemId: ids.folder });
    db.insert('AncestorIds', { ItemId: id, ParentItemId: aggregate.Id });
  }
  db.insert('AncestorIds', { ItemId: ids.folder, ParentItemId: aggregate.Id });
});
await db.snapshot(validationPath(path.join(root, 'initial.db')));
db.close();
const identityFile = validationPath(path.join(root, 'identities.json'));
await writeFile(identityFile, JSON.stringify({ ...JSON.parse(await readFile(identityFile, 'utf8')), ...ids }, null, 2));
console.log(JSON.stringify({ seededItems: 3, pathsRebased: true, initialSnapshotCreated: true }));
