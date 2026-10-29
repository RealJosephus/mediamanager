import { readFile, readdir, stat, mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openScenario } from '../channel-items/scenario.js';
import { tableDefinition } from '../../../../src/database/model.js';
import { idKey } from '../../../../src/library/records.js';
import { nativeGuid } from '../../../../src/users/native.js';
import { channelDataCachePath } from '../../../../src/library/channel-item-cache.js';
import { createTestApplication } from '../../../helpers/application.js';
import { AuthenticationService } from '../../../../src/users/authentication-service.js';
import { fields, userId, viewId } from './input.js';

export const tableNames = ['BaseItems', 'AncestorIds', 'LinkedChildren', 'ItemValues', 'ItemValuesMap', 'UserData',
  'MediaStreamInfos', 'Peoples', 'PeopleBaseItemMap', 'BaseItemImageInfos', 'BaseItemProviders', 'BaseItemMetadataFields'];
export async function files(root, directory) {
  const result = [];
  const visit = async current => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else result.push({ path: path.relative(root, filename).replaceAll('\\', '/'), text: await readFile(filename, 'utf8') });
    }
  };
  await visit(directory);
  return result.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

const user = { Id: nativeGuid(userId), Policy: { EnableAllFolders: true, EnableAllChannels: true, BlockedTags: [], AllowedTags: [],
  BlockUnratedItems: [], BlockedMediaFolders: [], BlockedChannels: [], EnabledFolders: [], EnabledChannels: [] },
Configuration: { GroupedFolders: [], MyMediaExcludes: [], OrderedViews: [] } };

export async function openYearChannelScenario(sample, expected, root, options = {}) {
  const f = await openScenario(sample, expected, root, options);
  let application, closing;
  const close = () => closing ??= (async () => {
    const errors = [];
    const attempt = async operation => { try { await operation(); } catch (reason) { errors.push(reason); } };
    application?.beginClose(); await attempt(() => application?.drainRequests());
    if (application?.server.listening) await attempt(() => new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())));
    await attempt(() => f.close());
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Year Channel fixture cleanup failed.', { cause: errors[0] });
  })();
  try {
    f.library.options.configuration.EnableNormalizedItemByNameIds = true;
    // The Native component explicitly controls ReverseVirtualPath as identity.
    // Keep that same path input through nested save contexts, rather than
    // projecting two different persisted path formats as equivalent.
    const previous = f.items.loadContext;
    const control = loaded => {
      loaded.reversePath = value => value;
      const capture = loaded.capturePathScope.bind(loaded);
      loaded.capturePathScope = value => ({ ...capture(value), reversePath: entry => entry });
      loaded.reloadMetadataContext = loadContext;
      return loaded;
    };
    const loadContext = Object.assign(async (...args) => control(await previous(...args)), previous);
    loadContext.withContext = async (id, settings, consume) => {
      const loaded = await loadContext(id, settings);
      try { return await consume(loaded); } finally { await loaded.dispose(); }
    };
    f.items.loadContext = f.metadata.loadContext = loadContext;
    for (const table of tableNames) if (table !== 'BaseItems') for (const row of expected.beforeTables[table]) {
      await f.database.upsert(table, Object.fromEntries(tableDefinition(table).columns.filter(column => Object.hasOwn(row, column.name))
        .map(column => [column.name, row[column.name] != null && column.clrType.replace('?', '') === 'Guid' ? nativeGuid(row[column.name]) : row[column.name]])));
    }
    const authentication = new AuthenticationService({ store: f.store, users: { getUser: async () => user }, serverId: 'channel-items', isLocalNetwork: () => true });
    authentication.authenticate = async request => ({ IsAuthenticated: true, IsAdministrator: true,
      IsApiKey: request.headers['x-user'] === 'false', UserId: request.headers['x-user'] === 'false' ? '0'.repeat(32) : userId,
      User: request.headers['x-user'] === 'false' ? null : user });
    application = await createTestApplication({ configuration: { IsStartupWizardCompleted: true }, authentication, library: f.library,
      channels: f.channels, users: { getUser: async () => user }, onError: reason => f.diagnostics.push(reason) });
    await new Promise((resolve, reject) => {
      application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => { application.server.off('error', reject); resolve(); });
    });
    const tables = () => f.store.run(async db => Object.fromEntries(await Promise.all(tableNames.map(async table => [table, await db.rows(table)]))));
    const snapshot = async () => {
      const persisted = await tables(), warm = [], directories = [];
      const rows = [...persisted.BaseItems].filter(row => row.Type !== 'PLACEHOLDER').sort((left, right) => idKey(left.Id).localeCompare(idKey(right.Id), 'en'));
      for (const row of rows) await f.items.withItem(row.Id, item => {
        warm.push({ Id: idKey(item.Id), Name: item.Name, Path: item.Path, ExternalId: item.ExternalId ?? null,
          ProductionYear: item.ProductionYear ?? null, RunTimeTicks: item.RunTimeTicks, Genres: item.Genres, Tags: item.Tags,
          Overview: item.Overview, channelId: idKey(item.ChannelId), parentId: idKey(item.ParentId), type: item.NativeType,
          displayParentId: item.Type === 'UserView' ? idKey(item.DisplayParentId) : null,
          artists: item.Artists ?? null, albumArtists: item.AlbumArtists ?? null });
      });
      for (const row of rows) if (row.Type === 'MediaBrowser.Controller.Entities.Year') {
        const info = await stat(f.library.options.expandPath(row.Path), { bigint: true });
        directories.push({ id: idKey(row.Id), createdTicks: String(info.birthtimeNs / 100n + 621355968000000000n),
          modifiedTicks: String(info.mtimeNs / 100n + 621355968000000000n) });
      }
      return { tables: persisted, warm, directories, cacheFiles: await files(root, path.join(root, 'cache')),
        mediaFiles: await files(root, path.join(root, 'metadata')), diagnostics: f.diagnostics };
    };
    const step = async (step, signal) => {
      signal?.throwIfAborted();
      let action, wire;
      if (step.kind === 'expire') {
        for (const file of await files(root, path.join(root, 'cache'))) await utimes(path.join(root, file.path), new Date(0), new Date(0));
        action = { value: true };
      } else if (step.kind === 'cache') {
        const provider = f.channels.plugins.entries('channel').find(value => value.name === step.provider);
        const id = expected.identities.find(value => value.name === step.provider).id;
        const userCacheKey = await provider.getCacheKey(null) ?? '';
        const filename = channelDataCachePath({ cachePath: path.join(root, 'cache'), channelId: id, dataVersion: provider.dataVersion, userCacheKey });
        await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, step.content); action = { value: true };
      } else {
        let parentId = expected.identities.find(value => value.name === step.provider)?.id;
        if (step.provider === 'Absent') parentId = expected.beforeRows.find(row => row.Type === 'MediaBrowser.Controller.Channels.Channel' && row.Name === 'Absent').Id;
        if (step.parentExternalId) parentId = (await f.database.rows('BaseItems', { where: { ExternalId: step.parentExternalId } }))[0].Id;
        await f.items.withItem(viewId, view => { view.DisplayParentId = nativeGuid(parentId); });
        if (step.warmExternalId) {
          const row = (await f.database.rows('BaseItems', { where: { ExternalId: step.warmExternalId } }))[0];
          await f.items.withItem(row.Id, item => { item.ProductionYear = step.warmProductionYear; });
        }
        const values = new URLSearchParams({ ParentId: viewId, Fields: fields.join(','), EnableImages: 'false', EnableUserData: 'true' });
        for (const [name, value] of Object.entries(step.query)) values.set(name, Array.isArray(value) ? value.join(',') : String(value));
        const route = '/Years?' + values;
        const response = await fetch('http://127.0.0.1:' + application.server.address().port + route, { headers: { 'X-User': String(step.user) }, signal });
        const bodyText = await response.text(), body = JSON.parse(bodyText);
        wire = { route, status: response.status, contentType: response.headers.get('content-type'), bodyText, body };
        action = response.ok ? { value: body } : { failure: { status: response.status, body } };
      }
      return { name: step.name, kind: step.kind, action, ...(wire ? { wire } : {}), ...await snapshot() };
    };
    return { ...f, close, step, snapshot, tables, user };
  } catch (reason) {
    try { await close(); } catch (cleanup) { throw new AggregateError([reason, cleanup], 'Year Channel fixture setup failed.', { cause: reason }); }
    throw reason;
  }
}
