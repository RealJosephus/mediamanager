import { testFileSystem } from '../storage/plugin-files.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { guid, idKey, dateText } from '../../src/library/records.js';
import { fixturePathStyle, projectStatePath, expandStatePath } from './fixture-state-path.js';

export const playlistDeletionId = key => `99d00000-0000-0000-0000-${String(key).padStart(12, '0')}`;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry);
const rewrite = (value, transform) => Array.isArray(value) ? value.map(entry => rewrite(entry, transform))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, transform)]))
    : typeof value === 'string' ? transform(value) : value;

export async function setupPlaylistDeletion(t, sample, recorded) {
  const fixture = await setupChildrenFixture(t), calls = [];
  useIdentityPathReversalControl(fixture);
  const expand = text => expandStatePath(text, '$STATE', fixture.stateRoot);
  // This is the recorded PRE-operation frame, not candidate expected state.
  const rows = recorded.initialRows.map(row => ({ ...rewrite(row, expand),
    Data: row.Data == null ? null : encode(rewrite(parseLosslessJson(row.Data), expand)) }));
  const pending = [...rows], inserted = new Set();
  while (pending.length) {
    const index = pending.findIndex(row => ['ParentId', 'OwnerId', 'PrimaryVersionId', 'TopParentId', 'SeriesId', 'SeasonId']
      .every(key => !row[key] || inserted.has(idKey(row[key])) || !rows.some(parent => idKey(parent.Id) === idKey(row[key]))));
    assert.ok(index >= 0);
    const row = pending.splice(index, 1)[0];
    if ((await fixture.database.rows('BaseItems', { where: { Id: row.Id } })).length) await fixture.database.update('BaseItems', { Id: row.Id }, row);
    else await fixture.database.insert('BaseItems', row);
    inserted.add(idKey(row.Id));
  }
  for (const link of recorded.initialLinks) await fixture.database.insert('LinkedChildren', link);
  fixture.vfs.mount({ path: '/playlist-source', instanceId: 'fixture', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  const mediaRoot = path.join(fixture.stateRoot, 'media');
  fixture.identityMap.addPrefix({ identityRoot: mediaRoot, accessRoot: '/playlist-source/media', style: fixturePathStyle,
    returnAccess: 'Isolated Playlist deletion media identity, never host-media access.' });
  await fixture.adapter.mkdir('/media');
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  ...fixture, metadataPath: path.join(fixture.stateRoot, 'metadata'),
    stateRoots: [path.join(fixture.stateRoot, 'data')] });
  const creator = new ItemCreationService(fixture); t.after(() => creator.close());
  fixture.library.itemCreation = creator;
  const item = await creator.getItemById(playlistDeletionId(1)), parent = await creator.getItemById(playlistDeletionId(2));
  const loaded = await fixture.loadContext(item.Id, { draft: item });
  const filename = sample.filename ?? 'Target', sourceIdentity = item.Path;
  const sourceAccess = sample.managed ? sourceIdentity : `/playlist-source/media/${filename}`;
  const write = async (identity, text) => assets.write(identity, Buffer.from(text));
  for (const [name, text] of [['sibling.keep', 'sibling'], ['Target.xml', 'sidecar'], ['member.flac', 'member']]) {
    await fixture.adapter.write(`/media/${name}`, Buffer.from(text));
  }
  if (!sample.missing) {
    if (sample.directory) {
      if (sample.managed) await write(path.join(sourceIdentity, 'source.txt'), 'source');
      else { await fixture.adapter.mkdir(`/media/${filename}`); await fixture.adapter.write(`/media/${filename}/source.txt`, Buffer.from('source')); }
    } else if (sample.managed) await write(sourceIdentity, 'source');
    else await fixture.adapter.write(`/media/${filename}`, Buffer.from('source'));
  }
  const internalMarker = path.join(internalImagePath(item, loaded.metadataPath), 'marker.txt');
  const externalMarker = path.join(loaded.dataPath, 'fixture-external', guid(item.Id), 'marker.txt');
  await write(internalMarker, 'internal'); await write(externalMarker, 'external');
  let closure;
  if (sample.owned || sample.child) {
    // A cold persisted-only row is deliberately not hydrated before deletion.
    const row = rows.find(row => row.Id === playlistDeletionId(4));
    const relative = path.relative(mediaRoot, row.Path);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    const access = '/media/' + relative.replaceAll('\\', '/');
    if (row.IsFolder) { await fixture.adapter.mkdir(access); await fixture.adapter.write(access + '/source.txt', Buffer.from('closure')); }
    else await fixture.adapter.write(access, Buffer.from('closure'));
    const shell = { Id: row.Id, Type: row.Type.split('.').at(-1) };
    await write(path.join(internalImagePath(shell, loaded.metadataPath), 'marker.txt'), 'closure-internal');
    await write(path.join(loaded.dataPath, 'fixture-external', guid(row.Id), 'marker.txt'), 'closure-external');
    if (sample.warm || sample.cached) closure = await creator.getItemById(row.Id);
    if (sample.cached) setFolderChildren(item, [closure]);
  }
  if (sample.nested) {
    await fixture.adapter.write('/media/nested.flac', Buffer.from('nested'));
    await write(path.join(internalImagePath({ Id: playlistDeletionId(5), Type: 'Audio' }, loaded.metadataPath), 'marker.txt'), 'nested-internal');
  }
  setFolderChildren(parent, [item]); parent.UserData = [];
  const exists = async identity => { try { await assets.stat(identity); return true; } catch (error) { if (error.code === 'not-found') return false; throw error; } };
  const state = async () => ({ sourceExists: await exists(sourceIdentity), internalExists: await exists(internalMarker),
    externalExists: await exists(externalMarker), databaseExists: (await fixture.database.rows('BaseItems', { where: { Id: item.Id } })).length !== 0,
    parentId: guid(item.ParentId) });
  const external = new ExternalDataManager({fileSystem: testFileSystem,  ...fixture, dataPath: loaded.dataPath, metadataPath: loaded.metadataPath });
  external.paths = current => [path.join(loaded.dataPath, 'fixture-external', guid(current.Id))];
  const removeExternal = external.deleteItemFiles.bind(external);
  external.deleteItemFiles = async (...args) => { calls.push({ action: 'external', id: guid(args[0].Id), state: await state() });
    if (sample.externalFailure) throw Object.assign(new Error('Controlled external cleanup failure.'), { code: 'io', nativeException: 'IOException' });
    return removeExternal(...args); };
  const deletion = new ItemDeletionService({ ...fixture, itemCreation: creator, updates: fixture.host.updates,
    externalData: external, linkedChildReferences: { reroute: async () => [] }, now: () => fixture.now });
  fixture.library.itemDeletion = deletion;
  const removeRows = deletion.deleteItems.bind(deletion);
  deletion.deleteItems = async (idsPlan, ...args) => {const keys=await fixture.store.run(async db=>(await db.client.query(idsPlan)).rows.map(row=>guid(row.Key)));calls.push({action:'delete',ids:keys,state:await state()});return removeRows(idsPlan,...args);};
  const events = [];
  fixture.library.on('ItemRemoved', event => events.push({ action: 'event', id: guid(event.Item.Id), parentId: event.Parent ? guid(event.Parent.Id) : null }));
  const originalDeleteDirectory = MetadataImageAssets.prototype.deleteDirectory;
  if (sample.internalFailure || sample.sourceFailure && sample.managed) {
    MetadataImageAssets.prototype.deleteDirectory = async function (identity, options) {
      if (sample.internalFailure && identity === path.dirname(internalMarker) || sample.sourceFailure && identity === sourceIdentity) {
        throw Object.assign(new Error('Controlled file cleanup failure.'), { code: 'io', nativeException: 'IOException' });
      }
      return originalDeleteDirectory.call(this, identity, options);
    };
    t.after(() => { MetadataImageAssets.prototype.deleteDirectory = originalDeleteDirectory; });
  }
  if (sample.sourceFailure && !sample.managed) {
    const remove = fixture.adapter.delete.bind(fixture.adapter);
    fixture.adapter.delete = async (location, options) => {
      if (location === `/media/${filename}`) throw Object.assign(new Error('Controlled source failure.'), { code: 'io', nativeException: 'IOException' });
      return remove(location, options);
    };
  }
  if (sample.sqlFailure) {
    await fixture.database.client.query("CREATE FUNCTION playlist_deletion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled deletion failure'; END $$");
    await fixture.database.client.query('CREATE TRIGGER playlist_deletion_failure BEFORE DELETE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION playlist_deletion_failure()');
  }
  // The recorded managed directory deliberately contains mixed separators.
  // Project both sides through the same isolated-root relocation as the seed.
  const projectPath = text => projectStatePath(expand(text), fixture.stateRoot);
  const normalizeRows = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    key === 'Data' && value != null ? rewrite(parseLosslessJson(value), projectPath)
      : key.startsWith('Date') && value != null ? dateText(value)
        : typeof value === 'string' ? projectPath(value) : value])))
    .sort((a, b) => ordinal(a.Id, b.Id));
  const links = async () => (await fixture.database.rows('LinkedChildren')).sort((a, b) => ordinal(a.ParentId, b.ParentId) || a.SortOrder - b.SortOrder);
  const files = async () => {
    const result = [];
    const local = async directory => { try { for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await local(filename);
      else result.push({ path: projectStatePath(filename, fixture.stateRoot), sha256: sha(await readFile(filename)) });
    } } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    for (const root of [loaded.dataPath, loaded.metadataPath]) await local(root);
    const network = async directory => { for (const entry of (await fixture.vfs.list(directory)).entries) {
      const filename = path.posix.join(directory, entry.name);
      if (entry.kind === 'directory') await network(filename);
      else { const handle = await fixture.vfs.openRead(filename); try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk);
        result.push({ path: '$STATE\\' + filename.slice('/playlist-source/'.length).replaceAll('/', '\\'), sha256: sha(Buffer.concat(chunks)) });
      } finally { await handle.close(); } }
    } };
    await network('/playlist-source/media'); return result.sort((a, b) => ordinal(a.path, b.path));
  };
  assert.deepEqual(normalizeRows(await fixture.database.rows('BaseItems')), normalizeRows(recorded.initialRows));
  assert.deepEqual(await links(), recorded.initialLinks); assert.deepEqual(await files(), recorded.initialFiles);
  const abort = new AbortController(); if (sample.cancelled) abort.abort();
  const operation = () => fixture.library.deleteItem(item, { DeleteFileLocation: sample.deleteSource ?? false, signal: abort.signal },
    sample.nullParent ? null : undefined, !sample.noNotify);
  const project = async exception => {
    const final = await state();
    return { name: sample.name, exception, calls: [...calls, ...events.map(event => ({ ...event, state: final }))],
      rows: normalizeRows(await fixture.database.rows('BaseItems')), links: await links(), files: await files(),
      targetParentId: guid(item.ParentId), targetLookup: await creator.getItemById(item.Id) != null,
      closureLookup: sample.owned || sample.child ? await creator.getItemById(playlistDeletionId(4)) != null : null,
      parentChildrenCleared: readCachedFolderChildren(parent, null, () => null) === null, parentUserDataCleared: parent.UserData === null };
  };
  return { fixture, creator, item, parent, loaded, closure, sourceIdentity, sourceAccess, internalMarker, externalMarker, assets,
    state, calls, events, files, normalizeRows, links, operation, project };
}
