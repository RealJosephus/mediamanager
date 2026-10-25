import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { PostgresDatabase } from '../../../../src/database/postgres.js';
import { nativeInsertionOrderedTables } from '../../../../src/database/native-relation-order.js';
import { createRuntime } from '../../../../src/runtime.js';
import { readInstanceConfiguration } from '../../../../src/configuration.js';
import { readConfigurationDocument } from '../../../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../../../src/core/configuration-file.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../../../database/postgres-fixture.js';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const idKey = value => String(value).replaceAll('-', '').toLowerCase();
export const guid = value => {
  const n = idKey(value);
  assert.match(n, /^[a-f0-9]{32}$/u);
  return `${n.slice(0,8)}-${n.slice(8,12)}-${n.slice(12,16)}-${n.slice(16,20)}-${n.slice(20)}`.toUpperCase();
};
// Fixture identities follow the bound native manager source, independently of
// the candidate timer parser, state index and query implementation.
const md5Guid = value => {
  const raw = createHash('md5').update(Buffer.from(value, 'utf16le')).digest(), bytes = Buffer.from(raw);
  bytes.writeUInt32BE(raw.readUInt32LE(0), 0); bytes.writeUInt16BE(raw.readUInt16LE(4), 4); bytes.writeUInt16BE(raw.readUInt16LE(6), 6);
  return bytes.toString('hex');
};
export const timerIdentity = id => md5Guid(('Emby' + (id ?? '') + '4').toLowerCase());
export const itemIdentity = (type, id) => md5Guid('MediaBrowser.Controller.LiveTv.' + type + ('Emby' + id + '4').toLowerCase());
export const tables = ['BaseItems', 'AncestorIds', 'UserData', 'Permissions', 'Preferences', 'BaseItemImageInfos',
  'BaseItemProviders', 'BaseItemMetadataFields', 'ItemValues', 'ItemValuesMap', 'LinkedChildren', 'MediaStreamInfos'];
export const stableRows = rows => rows.map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value)).sort();
const seedTables = ['BaseItems', 'AncestorIds', 'BaseItemImageInfos', 'BaseItemProviders', 'BaseItemMetadataFields',
  'ItemValues', 'ItemValuesMap', 'LinkedChildren', 'MediaStreamInfos'];
const insertionOrdered = new Set(nativeInsertionOrderedTables);
export const databaseFilename = root => path.join(root, 'data/data/jellyfin.db');
export const stateDirectory = root => path.join(root, 'data/data/livetv');

export async function writeDocuments(root, documents) {
  await mkdir(stateDirectory(root), { recursive: true });
  for (const [name, text] of Object.entries(documents)) await writeFile(path.join(stateDirectory(root), name), text);
}

export async function documentSnapshot(root) {
  return Object.fromEntries(await Promise.all(['timers.json', 'seriestimers.json'].map(async name => {
    const bytes = await readFile(path.join(stateDirectory(root), name));
    return [name, { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') }];
  })));
}

export function sqliteSnapshot(root) {
  const database = new SqliteDatabase(databaseFilename(root), { readOnly: true, requireMigrationHistory: true });
  try { return Object.fromEntries(tables.map(table => [table, stableRows(database.rows(table))])); }
  finally { database.close(); }
}

export function makeDocuments(input, clock, empty) {
  const start = day => new Date(clock + day * 86400000).toISOString().replace('.000Z', '.1234567Z');
  const end = day => new Date(clock + day * 86400000 + 5400000).toISOString().replace('.000Z', '.7654321Z');
  return Object.fromEntries([['timers', 'timers.json'], ['seriesTimers', 'seriestimers.json']].map(([kind, filename]) => [filename,
    JSON.stringify(empty ? [] : input[kind].map(({ day, ...entry }) => {
      assert.ok(Number.isInteger(day) && day >= 1 && day <= 6, 'Controlled timer execution must stay in the next seven days.');
      return { ...entry, StartDate: start(day), EndDate: end(day) };
    }), null, 2) + '\n']));
}

export async function seedGuide(root, liveRootId, clock, assets) {
  await mkdir(assets, { recursive: true });
  const picture = await readFile(new URL('../../../images/fixtures/processor/single.png', import.meta.url));
  assert.equal(picture.toString('hex', 0, 8), '89504e470d0a1a0a');
  const imagePath = path.join(assets, 'guide.png');
  await writeFile(imagePath, picture);
  const width = picture.readUInt32BE(16), height = picture.readUInt32BE(20);
  const sql = new SqliteDatabase(databaseFilename(root), { requireMigrationHistory: true });
  const channelIds = ['channel-one', 'channel-two'].map(value => guid(itemIdentity('LiveTvChannel', value)));
  const programIds = ['program-one', 'program-two', 'program-missing-channel', 'program-foreign-service'].map(value => guid(itemIdentity('LiveTvProgram', value)));
  const seriesId = '80300000-0000-0000-0000-000000000100';
  const row = values => postgresTestRow('BaseItems', { Data: '{}', DateCreated: '2026-10-01 01:02:03.1234567',
    DateModified: '2026-10-01 01:02:04.1234567', DateLastSaved: '2026-10-01 01:02:05.1234567',
    ChannelId: '00000000-0000-0000-0000-000000000000', TopParentId: guid(liveRootId), ParentId: guid(liveRootId),
    MediaType: 'Unknown', UnratedType: 'Other', ...values });
  try {
    sql.transaction(() => {
      for (const [index, id] of channelIds.entries()) sql.insert('BaseItems', row({ Id: id,
        Type: 'MediaBrowser.Controller.LiveTv.LiveTvChannel', Name: index ? 'Channel two' : 'Channel one',
        CleanName: index ? 'channel two' : 'channel one', SortName: String(index + 1),
        ExternalId: index ? 'channel-two' : 'channel-one', ExternalServiceId: 'Emby',
        Data: JSON.stringify({ Number: String(index + 1), ChannelType: index ? 'Radio' : 'TV' }) }));
      for (const [index, id] of programIds.entries()) {
        const title = index === 1 ? 'Show 10' : 'Show 2';
        sql.insert('BaseItems', row({ Id: id, Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram', Name: title,
          CleanName: title.toLowerCase(), SortName: title.toLowerCase(), ExternalId: ['program-one', 'program-two', 'program-missing-channel', 'program-foreign-service'][index],
          ExternalSeriesId: index === 1 ? 'guide-series-two' : 'guide-series', ChannelId: index === 2 ? '80300000-0000-0000-0000-000000009999' : channelIds[index % 2],
          IsVirtualItem: true, IsSeries: true, IsRepeat: index === 1, EpisodeTitle: 'Episode ' + (index + 1),
          Overview: 'Guide overview 中文', Genres: 'Drama', Tags: 'Live', RunTimeTicks: 54000000000n,
          StartDate: new Date(clock + 86400000).toISOString().replace('T', ' ').replace('.000Z', '.1234567'),
          EndDate: new Date(clock + 86400000 + 5400000).toISOString().replace('T', ' ').replace('.000Z', '.7654321') }));
      }
      // The foreign-service channel is separate; its program remains a real
      // persisted LiveTvProgram, so defaults must reach the native service gate.
      const foreignChannel = '80300000-0000-0000-0000-000000000200';
      sql.insert('BaseItems', row({ Id: foreignChannel, Type: 'MediaBrowser.Controller.LiveTv.LiveTvChannel', Name: 'Foreign channel',
        ExternalId: 'foreign-channel', ExternalServiceId: 'Unregistered', Data: '{"Number":"3","ChannelType":"TV"}' }));
      sql.update('BaseItems', { Id: programIds[3] }, { ChannelId: foreignChannel });
      sql.insert('BaseItems', row({ Id: seriesId, Type: 'MediaBrowser.Controller.Entities.TV.Series', Name: 'Show 2', CleanName: 'show 2',
        SortName: 'show 2', IsFolder: true, MediaType: 'Video', UnratedType: 'Series', PresentationUniqueKey: idKey(seriesId) }));
      for (const id of [...channelIds, ...programIds, seriesId, foreignChannel]) sql.insert('AncestorIds', { ItemId: id, ParentItemId: guid(liveRootId) });
      let sequence = 1;
      for (const [itemId, types] of [[channelIds[0], [0]], [channelIds[1], [0]], [seriesId, [5, 2, 0]], [programIds[0], [0, 2]], [programIds[1], [0, 2]]]) {
        for (const imageType of types) sql.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', {
          Id: `80300000-0000-0000-0000-${String(sequence++).padStart(12, '0')}`, ItemId: itemId,
          ImageType: imageType, Path: imagePath, DateModified: '2026-10-01 01:02:03.1234567', Width: width, Height: height }));
      }
    });
  } finally { sql.close(); }
  return { channelIds: channelIds.map(idKey), programIds: programIds.map(idKey), seriesId: idKey(seriesId),
    image: { path: imagePath, bytes: picture.length, sha256: sha(picture), width, height } };
}

async function rebaseConfiguration(directory, previous, replacement) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await rebaseConfiguration(filename, previous, replacement);
    else if (/\.(xml|json)$/iu.test(entry.name)) await writeFile(filename, (await readFile(filename, 'utf8'))
      .replaceAll(previous.replaceAll('\\', '\\\\'), replacement.replaceAll('\\', '\\\\'))
      .replaceAll(previous.replaceAll('\\', '/'), replacement.replaceAll('\\', '/')).replaceAll(previous, replacement));
  }
}

/** Fresh PostgreSQL/runtime HTTP fixture; deliberately not a production CLI import. */
export async function createTimerRuntime({ sourceRoot, root, serverId, errors, documents, shutdownStates, reservedPorts = [] }) {
  await cp(sourceRoot, root, { recursive: true, filter: filename => !path.relative(sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
  await rebaseConfiguration(path.join(root, 'config'), sourceRoot, root);
  // The Node copy owns an explicit listener input. Select it before constructing
  // the runtime so a stopped Native lifetime can reclaim its reserved port.
  let httpPort;
  for (let attempt = 0; attempt < 16; attempt++) {
    const reservation = createServer(); let selected, failure;
    try {
      await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
      selected = reservation.address().port;
    } catch (error) { failure = error; }
    try { if (reservation.listening) await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve())); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Timer listener input preparation and release failed.', { cause: failure }) : error; }
    if (failure) throw failure;
    if (!reservedPorts.includes(selected)) { httpPort = selected; break; }
  }
  assert.ok(httpPort !== undefined, 'The Node listener must leave the stopped native process port available for its next lifetime.');
  const networkFilename = path.join(root, 'config/network.xml');
  const networkDocument = readConfigurationDocument(await readFile(networkFilename), 'network');
  await writeConfigurationFile(networkFilename, 'network', { ...networkDocument.value, InternalHttpPort: httpPort,
    LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true }, { source: networkDocument.node });
  await writeDocuments(root, documents);
  let database = await createPostgresTestDatabase(null, 'timer_http'), application, origin, closing;
  const close = () => closing ??= (async () => {
    try {
      await application?.close();
      if (application) assert.ok(application.networkHost.listeners.every(listener => !listener.server.listening));
    }
    finally { await dropPostgresTestDatabase(database); }
  })();
  try {
    const source = new SqliteDatabase(databaseFilename(sourceRoot), { readOnly: true, requireMigrationHistory: true });
    try {
      await database.transaction(async session => {
        await session.client.query('SET CONSTRAINTS ALL DEFERRED');
        const insert = async (table, rows) => {
          for (const row of rows) {
            const values = { ...row };
            if (table === 'BaseItems') for (const key of ['Path', 'Data']) if (typeof values[key] === 'string') values[key] = values[key]
              .replaceAll(sourceRoot.replaceAll('\\', '\\\\'), root.replaceAll('\\', '\\\\'))
              .replaceAll(sourceRoot.replaceAll('\\', '/'), root.replaceAll('\\', '/')).replaceAll(sourceRoot, root);
            await session.insert(table, values);
          }
        };
        for (const table of seedTables) {
          if (!insertionOrdered.has(table)) { await insert(table, source.rows(table)); continue; }
          let after;
          while (true) {
            const batch = await source.relationRowsInInsertionOrder(table, { after, limit: 128 });
            if (!batch.rows.length) break;
            await insert(table, batch.rows); after = batch.after;
          }
        }
      });
    } finally { source.close(); }
    assert.equal(await database.getState('liveTvNativeState'), undefined, 'The source documents must precede the first runtime import.');
    const settings = await readInstanceConfiguration(root);
    assert.equal(settings.serverId, serverId);
    const snapshot = () => application.store.run(async db => ({ tables: Object.fromEntries(await Promise.all(tables.map(async table => [table, stableRows(await db.rows(table))]))),
      liveTvNativeState: await db.getState('liveTvNativeState') }));
    const start = async () => {
      application = await createRuntime({ ...settings, database, onError: error => errors.push({ name: error.name, message: error.message }) });
      const closeStore = application.store.close.bind(application.store);
      application.store.close = async () => { shutdownStates.push({ database: await snapshot(), documents: await documentSnapshot(root) }); return closeStore(); };
      await application.start();
      origin = `http://127.0.0.1:${application.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
    };
    await start();
    return { get application() { return application; }, get origin() { return origin; }, root, snapshot, close,
      async restart() {
        const schema = database.schemaName;
        await application.close();
        assert.ok(application.networkHost.listeners.every(listener => !listener.server.listening));
        database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
        await start();
      } };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Timer fixture startup and cleanup failed.'); }
    throw error;
  }
}
