import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../../../database/postgres-fixture.js';
import { testFileSystem } from '../../../storage/plugin-files.js';
import { DomainStore } from '../../../../src/database/domain-store.js';
import { LibraryService } from '../../../../src/library/library-service.js';
import { PostgresLinkedChildrenStore } from '../../../../src/library/postgres-linked-children.js';
import { tableDefinition, quoteIdentifier as q } from '../../../../src/database/model.js';
import { mediaSources, projectItem, dtoOptions } from '../../../../src/library/dto.js';
import { mapRecord, idKey } from '../../../../src/library/records.js';
import { nativeGuid } from '../../../../src/users/native.js';
import { stringifyNativeJson } from '../../../../src/core/json.js';
import { sourceFields, streamFields } from './input.js';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value instanceof Map ? Object.fromEntries(value) : value;
export function projectSource(source) {
  if (source == null) return null;
  return { ...Object.fromEntries(sourceFields.map(name => [name, source[name] == null ? null
    : ['Size', 'RunTimeTicks'].includes(name) ? String(source[name]) : plain(source[name])])),
  DefaultAudioIndexSource: source.DefaultAudioIndexSource ?? 0,
  MediaStreams: source.MediaStreams?.map(stream => stream == null ? null : Object.fromEntries(streamFields.map(name => [name, stream[name] ?? null]))) ?? null,
  MediaAttachments: source.MediaAttachments ?? null };
}
export function canonicalSourceObservation(observation) {
  if (observation.failure) return observation;
  return { value: observation.value?.map(projectSource) ?? null };
}
export function projectDto(dto) {
  return { SourceType: dto.SourceType ?? null, ChannelName: dto.ChannelName ?? null,
    EnableMediaSourceDisplay: dto.EnableMediaSourceDisplay ?? null,
    MediaSources: dto.MediaSources?.map(projectSource) ?? null, MediaStreams: dto.MediaStreams?.map(stream => Object.fromEntries(streamFields.map(name => [name, stream[name] ?? null]))) ?? null,
    MediaSourceCount: dto.MediaSourceCount ?? null };
}
export const errorRecord = error => ({ type: error.nativeException ?? error.name, status: error.status ?? error.statusCode ?? 500, Message: error.message, StackTrace: error.stack });
export async function observe(operation) { try { return { value: await operation() }; } catch (error) { return { failure: errorRecord(error) }; } }
const tables = ['BaseItems', 'UserData', 'LinkedChildren', 'Users', 'Permissions', 'Preferences', 'MediaStreamInfos', 'AttachmentStreamInfos'];
const stable = rows => rows.map(row => stringifyNativeJson(row)).sort();
export async function within(promise, name) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + name)), 30000); })]); }
  finally { clearTimeout(timer); }
}

export async function openScenario(input) {
  let database, store, links, library;
  const applicationPaths = {};
  const sourceQueries = [];
  const close = async () => {
    const errors = [], attempt = async action => { try { await action(); } catch (error) { errors.push(error); } };
    await attempt(() => library?.close()); await attempt(() => links?.flushReleases()); await attempt(() => links?.close());
    await attempt(() => store?.close()); await attempt(() => dropPostgresTestDatabase(database));
    if (errors.length) throw new AggregateError(errors, 'Saved channel source owners failed to close.');
  };
  try {
    database = await createPostgresTestDatabase(null, 'channel_cache'); store = new DomainStore(database);
    links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    library = new LibraryService({ store, linkedChildren: links, fileSystem: testFileSystem, serverId: 'channel-static-component', configuration: {},
      get metadataPath() { return applicationPaths.metadataPath; } });
    await database.insert('Users', postgresTestRow('Users', { Id: nativeGuid(input.userId), Username: 'channel-static', NormalizedUsername: 'CHANNEL-STATIC', InternalId: 1,
      AuthenticationProviderId: 'controlled', PasswordResetProviderId: 'controlled' }));
    const originalQuery = database.client.query;
    database.client.query = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      const values = typeof args[0] === 'string' ? args[1] : args[0]?.values;
      if (text.includes('/* page-relationship-graph */')) sourceQueries.push({ ids: values?.[0] });
      return originalQuery(...args);
    };
    const rows = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))])));
    const released = async () => {
      await links.flushReleases();
      const state = await database.client.query(`SELECT (SELECT count(*) FROM ${q(links.schemaName)}.item_states)::integer AS states,
        (SELECT count(*) FROM ${q(links.schemaName)}.item_cohorts)::integer AS cohorts`);
      assert.deepEqual(state.rows[0], { states: 0, cohorts: 0 }); return state.rows[0];
    };
    const prepare = async (sample, native) => {
      const columns = new Map(tableDefinition('BaseItems').columns.map(column => [column.name, column]));
      const records = native.rows.map(row => postgresTestRow('BaseItems', Object.fromEntries(Object.entries(row).filter(([name]) => columns.has(name))
        .map(([name, value]) => [name, value != null && columns.get(name).clrType.replace('?', '') === 'Guid' ? nativeGuid(value) : value]))));
      await database.transaction(async db => {
        await db.client.query('SET CONSTRAINTS ALL DEFERRED');
        // Every case supplies an independent graph and complete user data;
        // deferred foreign keys do not remove rows when the same IDs return.
        await db.client.query('DELETE FROM "LinkedChildren"'); await db.client.query('DELETE FROM "UserData"');
        await db.client.query('DELETE FROM "BaseItems"');
        for (const record of records) await db.insert('BaseItems', record);
        if (sample.linked) await db.insert('LinkedChildren', { ParentId: nativeGuid(input.itemId), ChildId: nativeGuid(input.alternateId), ChildType: 3, SortOrder: 0 });
        for (const data of native.userData) await db.insert('UserData', postgresTestRow('UserData', { ItemId: nativeGuid(data.itemId), UserId: nativeGuid(input.userId),
          CustomDataKey: data.value.Key, PlaybackPositionTicks: BigInt(data.value.PlaybackPositionTicks), PlayCount: data.value.PlayCount,
          Played: data.value.Played, LastPlayedDate: data.value.LastPlayedDate, AudioStreamIndex: data.value.AudioStreamIndex, SubtitleStreamIndex: data.value.SubtitleStreamIndex }));
      });
      applicationPaths.metadataPath = native.metadataPath;
      const user = sample.user ? { Id: nativeGuid(input.userId), Username: 'channel-static', ...sample.user.configuration,
        Policy: { EnableAllFolders: true, EnableAllChannels: true, EnabledChannels: [], BlockedChannels: [], EnabledFolders: [], BlockedMediaFolders: [],
          BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], ...sample.user.policy } } : null;
      const item = mapRecord(records.find(row => idKey(row.Id) === native.itemId));
      const before = await rows(), cacheBefore = sample.storage === 'file' ? await readFile(native.cachePath) : null;
      const evaluate = operation => store.run(async db => {
        const state = await library.load(db, user, { baseRows: records });
        try { return await operation(state.byId.get(native.itemId), state); } finally { await state.dispose({ session: db }); }
      });
      return { item, user, native, before, cacheBefore,
        base: () => evaluate((target, state) => mediaSources(target, state, null, library.options, true)),
        static: () => evaluate((target, state) => mediaSources(target, state, user, library.options, true)),
        dto: () => evaluate((target, state) => projectItem(target, state, user, dtoOptions({ fields: sample.fields ?? ['MediaSources', 'MediaStreams', 'MediaSourceCount', 'EnableMediaSourceDisplay'],
          enableimages: false, enableuserdata: false }), library.options)),
        playback: () => library.getMediaSources(native.itemId, { user }),
        live: () => library.getLiveMediaSources(item),
        async assertUnchanged() {
          assert.deepEqual(await rows(), before);
          if (cacheBefore) assert.deepEqual(await readFile(native.cachePath), cacheBefore);
          return released();
        } };
    };
    return { database, library, prepare, sourceQueries, released, close };
  } catch (error) { await close(); throw error; }
}
