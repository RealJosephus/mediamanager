import assert from 'node:assert/strict';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../../../database/postgres-fixture.js';
import { testFileSystem } from '../../../storage/plugin-files.js';
import { DomainStore } from '../../../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier as q } from '../../../../src/database/model.js';
import { LibraryService } from '../../../../src/library/library-service.js';
import { ItemCreationService } from '../../../../src/library/item-creation-service.js';
import { PostgresLinkedChildrenStore } from '../../../../src/library/postgres-linked-children.js';
import { LiveTvMediaSources } from '../../../../src/library/live-tv-media-sources.js';
import { mediaSources } from '../../../../src/library/dto.js';
import { idKey } from '../../../../src/library/records.js';
import { sourceFields, streamFields } from './input.js';

const plain = value => value instanceof Map ? Object.fromEntries(value) : typeof value === 'bigint' ? Number(value) : value;
export function projectSource(source) {
  return { ...Object.fromEntries(sourceFields.map(name => [name, plain(source[name]) ?? null])),
    DefaultAudioIndexSource: source.DefaultAudioIndexSource ?? 0,
    MediaStreams: source.MediaStreams?.map(stream => Object.fromEntries(streamFields.map(name => [name, stream[name] ?? null]))) ?? null };
}
const stable = rows => rows.map(row => JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? String(value) : value)).sort();
const tables = ['BaseItems', 'BaseItemProviders', 'MediaStreamInfos', 'UserData', 'Users', 'Permissions', 'Preferences'];

export async function openScenario(input) {
  let database, store, links, library, items;
  const owners = new Set();
  const close = async () => {
    const failures = [];
    const attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    for (const owner of owners) await attempt(() => owner.close());
    await attempt(() => items?.close()); await attempt(() => library?.close());
    await attempt(() => links?.flushReleases()); await attempt(() => links?.close());
    // Drop the private schema while its store is still usable, then close both
    // the real store and pool. Every cleanup still runs after an earlier failure.
    await attempt(() => dropPostgresTestDatabase(database)); await attempt(() => store?.close());
    if (failures.length) throw new AggregateError(failures, 'Live TV media-source fixture owners failed to close.');
  };
  try {
    database = await createPostgresTestDatabase(null, 'live_tv_media'); store = new DomainStore(database);
    links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    library = new LibraryService({ store, linkedChildren: links, fileSystem: testFileSystem, serverId: 'live-tv-media-sources', configuration: {} });
    items = new ItemCreationService({ store, library, linkedChildren: links,
      loadContext() { throw new Error('Read-only media-source discovery must not enter metadata creation.'); } });
    library.itemCreation = items;
    await database.insert('Users', postgresTestRow('Users', { Id: input.userId, Username: 'discovery', NormalizedUsername: 'DISCOVERY',
      AuthenticationProviderId: 'controlled', PasswordResetProviderId: 'controlled', InternalId: 1 }));
    const rows = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))])));
    const assertReleased = async () => {
      await links.flushReleases();
      const result = await database.client.query(`SELECT (SELECT count(*) FROM ${q(links.schemaName)}.item_states)::integer AS states,
        (SELECT count(*) FROM ${q(links.schemaName)}.item_cohorts)::integer AS cohorts`);
      assert.deepEqual(result.rows[0], { states: 0, cohorts: 0 });
      return result.rows[0];
    };
    const prepare = async (sample, native, { beforeSources } = {}) => {
      await items.close();
      for (const row of await database.rows('BaseItems')) await database.delete('BaseItems', { Id: row.Id });
      const columns = new Set(tableDefinition('BaseItems').columns.map(column => column.name));
      const row = postgresTestRow('BaseItems', Object.fromEntries(Object.entries(native.row).filter(([key]) => columns.has(key))));
      await database.insert('BaseItems', row);
      const data = sample.userData ?? { Key: sample.item.Id, AudioStreamIndex: 1, SubtitleStreamIndex: 3 };
      await database.insert('UserData', postgresTestRow('UserData', { ItemId: row.Id, UserId: input.userId,
        CustomDataKey: data.Key, AudioStreamIndex: data.AudioStreamIndex, SubtitleStreamIndex: data.SubtitleStreamIndex }));
      const item = await items.getItemById(row.Id);
      assert.equal(item.Type, 'LiveTvChannel'); assert.equal(item.EnableRememberingTrackSelections, false);
      const baseline = await rows(), supplied = structuredClone(native.preparedSources), suppliedBefore = structuredClone(supplied);
      const errors = [], calls = [], controller = new AbortController();
      if (sample.preCancelled) controller.abort();
      const service = new LiveTvMediaSources({ library, getLocalApiUrl: () => input.localApiUrl,
        onError: error => errors.push({ name: error.nativeException ?? error.name, message: error.message }), tuners: {
          name: 'Emby', async getChannelStreamMediaSources(id, { signal }) {
            calls.push({ id, cancelled: signal?.aborted === true }); await beforeSources?.({ signal });
            if (sample.failure) throw Object.assign(new Error('Controlled discovery failure.'), { nativeException: sample.failure });
            return supplied.map(mediaSource => ({ mode: 'native', mediaSource }));
          },
        } });
      owners.add(service);
      const user = sample.user ? { Id: input.userId, Username: 'discovery', Configuration: sample.user.configuration,
        Policy: { EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], ...sample.user.policy } } : null;
      const staticSources = await store.run(async db => {
        const state = await library.load(db, user, { baseRows: [row] });
        try { return (await mediaSources(state.byId.get(idKey(row.Id)), state, user, library.options)).map(projectSource); }
        finally { await state.dispose({ session: db }); }
      });
      const assertUnchanged = async () => {
        assert.deepEqual(supplied, suppliedBefore, 'Normalization must not mutate its owned tuner input.');
        assert.deepEqual(await rows(), baseline, 'Source discovery must retain library, user data, permissions and preferences.');
        return assertReleased();
      };
      return { item, user, service, signal: controller.signal, calls, errors, staticSources, assertUnchanged,
        discover: () => service.getMediaSources(item, { signal: controller.signal }),
        playback: sources => library.getMediaSources(item.Id, { user, dynamicSources: sources }),
        async close() { await service.close(); owners.delete(service); } };
    };
    return { library, prepare, assertReleased, close };
  } catch (error) { await close(); throw error; }
}
