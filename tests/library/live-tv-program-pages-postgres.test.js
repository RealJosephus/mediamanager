import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { decodeNativeTextBytes } from '../../src/database/native-text.js';
import { nativeRootUserViewIdentity } from '../../src/library/identity.js';
import { idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

export const requiredValidationServices = ['postgres'];
const id = value => '819a0000-0000-0000-0000-' + String(value).padStart(12, '0');

test('Live TV reads the selected programs, relations and DTOs in bounded PostgreSQL pages', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 90000,
}, async t => {
  const fixture = await setupChildrenFixture(t);
  const view = nativeRootUserViewIdentity('livetv', fixture.library.options);
  fixture.library.clock = () => new Date(fixture.now);
  const programs = Array.from({ length: 260 }, (_, index) => ({
    key: 'program-' + index, type: 'LiveTvProgram', Id: id(1000 - index), parent: 'live-tv',
    ancestors: ['live-tv'], TopParentId: view.Id, ChannelId: id(3), PresentationUniqueKey: 'guide-' + index,
    StartDate: new Date(Date.parse(fixture.now) + 60_000 * index).toISOString(),
    EndDate: new Date(Date.parse(fixture.now) + 60_000 * (index + 10)).toISOString(),
    Tags: [2, 128, 259].includes(index) ? ['blocked'] : [], MediaType: 'Video',
  }));
  await fixture.seed({ target: 'live-tv', items: [
    { key: 'live-tv', type: 'UserView', Id: view.Id, Name: 'Live TV', Path: view.StoredPath,
      ViewType: 'livetv', DateLastRefreshed: fixture.now, TopParentId: view.Id },
    { key: 'channel', type: 'LiveTvChannel', Id: id(3), Name: 'Guide channel', parent: 'live-tv',
      ancestors: ['live-tv'], TopParentId: view.Id, Number: '42', ChannelType: 'Radio', MediaType: 'Audio' },
    ...programs,
  ] });
  await fixture.database.update('BaseItems', { Id: id(3) }, { Type: 'MediaBrowser.Controller.LiveTv.LiveTvChannel' });
  const user = { Id: id(4), Policy: { EnableAllFolders: true, BlockedMediaFolders: [], EnabledFolders: [],
    BlockedTags: ['blocked'], AllowedTags: [], BlockUnratedItems: [] }, Configuration: { GroupedFolders: [] } };
  const expected = programs.filter(program => !program.Tags.length).map(program => idKey(program.Id));
  const programIds = new Set(programs.map(program => idKey(program.Id)));
  const output = path.join(validationOutputRoot(), 'live-tv-program-pages-' + randomUUID());
  await mkdir(output);

  await fixture.store.run(async db => {
    const report = { fetches: [], hydration: [], graphs: [], projection: [] };
    const cursors = async () => (await db.client.query('SELECT name FROM pg_cursors ORDER BY name')).rows;
    const before = await cursors();
    const query = db.client.query, rows = db.rows, load = fixture.library.load;
    db.client.query = async function (request, ...args) {
      const result = await query.call(this, request, ...args);
      const text = typeof request === 'string' ? request : request.text;
      if (text.startsWith('FETCH FORWARD') && result.rows.some(row => row.Id instanceof Uint8Array
        && programIds.has(idKey(decodeNativeTextBytes(row.Id))))) report.fetches.push(result.rows.length);
      if (text.startsWith('/* page-relationship-graph */')
        && request.values[0].some(id => programIds.has(idKey(id)))) report.graphs.push(request.values[0].length);
      return result;
    };
    db.rows = async function (table, options) {
      const result = await rows.call(this, table, options);
      if (table === 'BaseItems' && options?.whereIn?.Id
        && result.some(row => programIds.has(idKey(row.Id)))) report.hydration.push(result.length);
      return result;
    };
    let activeProgramStates = 0;
    fixture.library.load = async function (...args) {
      const count = args[2].baseRows.filter(row => row.Type === 'MediaBrowser.Controller.LiveTv.LiveTvProgram').length;
      const state = await load.apply(this, args);
      if (count) {
        assert.equal(activeProgramStates++, 0);
        report.projection.push(count);
        const dispose = state.dispose.bind(state);
        state.dispose = async options => { try { await dispose(options); } finally { activeProgramStates--; } };
      }
      return state;
    };
    try {
      const input = { fields: ['ChannelInfo'], enabletotalrecordcount: true };
      const complete = await fixture.library.queryLiveTvPrograms(input, { user });
      assert.deepEqual(complete.Items.map(item => item.Id), expected);
      assert.equal(complete.TotalRecordCount, 257);
      assert.equal(complete.StartIndex, 0);
      for (const item of complete.Items) assert.deepEqual([item.ChannelName, item.ChannelNumber, item.MediaType],
        ['Guide channel', '42', 'Audio'], item.Id);
      for (const [stage, counts] of Object.entries(report)) assert.deepEqual(counts, [128, 128, 1], stage);
      const paginated = await fixture.library.queryLiveTvPrograms({ ...input, startindex: 126, limit: 130 }, { user });
      assert.deepEqual(paginated, { Items: complete.Items.slice(126, 256), StartIndex: 126, TotalRecordCount: 257 });
      const noCount = await fixture.library.queryLiveTvPrograms({ ...input, startindex: 126, limit: 130, enabletotalrecordcount: false }, { user });
      assert.deepEqual(noCount, { ...paginated, TotalRecordCount: 130 });
      const empty = await fixture.library.queryLiveTvPrograms({ ...input, startindex: 258, limit: 1 }, { user });
      assert.deepEqual(empty, { Items: [], StartIndex: 258, TotalRecordCount: 257 });
      assert.equal(activeProgramStates, 0);
      assert.deepEqual(await cursors(), before);
      await writeFile(path.join(output, 'responses.json'), JSON.stringify({ complete, paginated, noCount, empty, report,
        openCursorsAfterRequests: await cursors() }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    } finally {
      db.client.query = query;
      db.rows = rows;
      fixture.library.load = load;
    }
  });
});
