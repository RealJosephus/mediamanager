import test from 'node:test';
import assert from 'node:assert/strict';
import { withGuideProgramBatch } from '../../src/library/live-tv-guide-store.js';
import { materializeGuideProgram, guideProgramId } from '../../src/library/live-tv-guide-program.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { onMetadataChanged } from '../../src/metadata/metadata-changed.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../../src/database/native-text.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { dateTicks, idKey } from '../../src/library/records.js';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';

export const requiredValidationServices = ['postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES;
const rootId = 'a9700000000000000000000000000001', channelId = 'a9700000000000000000000000000002';
const metadataChanged = item => onMetadataChanged(item, null);
const program = (index, fields = {}) => ({ Id: 'guide-program-' + index, Name: 'Program ' + index, ShowId: null, SeriesId: null,
  StartDate: '2500-01-01T00:00:00.0000000Z', EndDate: '2500-01-01T01:00:00.0000000Z', Audio: null, CommunityRating: null,
  EpisodeTitle: null, IsSeries: false, IsLive: false, IsPremiere: false, IsNews: false, IsSports: false, IsKids: false, IsRepeat: false,
  IsMovie: false, IsHD: null, Genres: [], OfficialRating: null, Overview: null, ProductionYear: null, OriginalAirDate: null,
  EpisodeNumber: null, SeasonNumber: null, ImagePath: null, ImageUrl: null, ThumbImageUrl: null, LogoImageUrl: null, BackdropImageUrl: null,
  ProviderIds: {}, SeriesProviderIds: {}, Etag: 'external-v1', ...fields });

async function setup(t, existing = 0) {
  const fixture = await setupChildrenFixture(t); useIdentityPathReversalControl(fixture);
  await fixture.seed({ target: 'root', items: [{ key: 'root', type: 'Folder', Id: rootId, Name: 'Guide root', Path: null }] });
  const parent = await fixture.library.itemCreation.getItemById(rootId), channel = newNativeItemEntity('MediaBrowser.Controller.LiveTv.LiveTvChannel');
  Object.assign(channel, { Id: channelId, Name: 'Guide channel', ParentId: rootId, ServiceName: 'Emby' });
  await fixture.library.itemCreation.createItems([channel], parent, { creationIntent: 'library-save' });
  fixture.library.itemCreation.unregisterItem(channel.Id);
  assert.equal((await fixture.library.itemCreation.getItemById(channel.Id)).ServiceName, 'Emby');
  if (existing) {
    const programs = [];
    for (let index = 0; index < existing; index++) programs.push((await materializeGuideProgram(program(index),
      { channel, now: () => fixture.now, metadataChanged })).item);
    await fixture.library.itemCreation.createItems(programs, channel, { creationIntent: 'library-save' });
  }
  let clock = 0;
  const now = () => new Date(Date.parse(fixture.now) + ++clock).toISOString();
  return { ...fixture, channel, options: { store: fixture.store, library: fixture.library, linkedChildren: fixture.linkedChildren,
    loadContext: fixture.loadContext, updates: fixture.host.updates, channel, metadataChanged, now } };
}

async function viewValues(view, select = item => ({ Id: idKey(item.Id), Name: item.Name })) {
  const values = [];
  try {
    for (let after = 0n; ;) {
      const page = await view.page({ after, limit: 128 });
      try {
        assert.ok(page.entries.length <= 128);
        if (!page.entries.length) break;
        values.push(...page.entries.map(entry => select(entry.item)));
        after = page.entries.at(-1).Ordinal;
      } finally { await page.release(); }
    }
  } finally { await view.release(); }
  return values;
}

async function rows(fixture) {
  return fixture.store.run(db => db.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram' } }));
}

async function assertReleased(fixture) {
  const result = await fixture.database.client.query(`SELECT (SELECT count(*) FROM ${q(fixture.linkedChildren.schemaName)}.item_states) AS states,
    (SELECT count(*) FROM ${q(fixture.linkedChildren.schemaName)}.item_cohorts) AS views`);
  assert.equal(BigInt(result.rows[0].states), 0n); assert.equal(BigInt(result.rows[0].views), 0n);
  await fixture.database.withConnection(async session => {
    const result = await session.client.query("SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'mm_guide_%'");
    assert.equal(BigInt(result.rows[0].count), 0n);
  });
}

test('guide new programs stay in SQL until seal and commit once across 128-row pages with last-ID winners and global insert order', { skip: !enabled, timeout: 180000 }, async t => {
  const fixture = await setup(t), observedPages = [];
  fixture.database.queryHook = async (...args) => {
    const result = await fixture.database.client.query(...args), sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (/guide-(?:capture|occurrence)-page/u.test(sql)) { assert.ok(result.rows.length <= 128); observedPages.push(result.rows.length); }
    return result;
  };
  t.after(() => { fixture.database.queryHook = null; });
  await withGuideProgramBatch(fixture.options, async batch => {
    assert.equal(batch.counts.existing, 0n);
    const first = await batch.consume(program(0, { Name: 'First new occurrence', IsKids: true }));
    for (let index = 1; index < 131; index++) await batch.consume(program(index));
    const last = await batch.consume(program(0, { Name: 'Final new occurrence', Genres: ['Drama'], ProviderIds: { Custom: 'last' },
      ShowId: 'persisted-show', EpisodeTitle: 'Persisted episode', IsMovie: true, IsRepeat: true }));
    assert.notEqual(first.SlotKey, last.SlotKey, 'New duplicates never enter the initial dictionary.');
    assert.equal(last.isNew, true); assert.equal((await rows(fixture)).length, 0);
    await assert.rejects(batch.saveNew(), /seal/u); batch.seal();
    assert.deepEqual(batch.counts, { existing: 0n, seen: 132n, new: 132n, updated: 0n });
    const beforeSave = await viewValues(batch.newView); assert.equal(beforeSave.length, 132);
    assert.equal(beforeSave[0].Name, 'First new occurrence'); assert.equal(beforeSave.at(-1).Name, 'Final new occurrence');
    await batch.saveNew(); assert.equal((await rows(fixture)).length, 131);
    assert.equal(batch.flags.isKids, true);
    const seen = batch.seenPlan, result = await batch.query(`SELECT count(*) AS count FROM (${seen.text}) seen`, seen.values);
    assert.equal(BigInt(result.rows[0].count), 132n);
    const precache = await viewValues(batch.newView); assert.equal(precache.length, 132);
    await batch.saveUpdated();
  });
  fixture.database.queryHook = null;
  const saved = await rows(fixture), duplicate = saved.find(row => idKey(row.Id) === guideProgramId(program(0).Id));
  assert.equal(duplicate.Name, 'Final new occurrence'); assert.equal(duplicate.Genres, 'Drama');
  const ancestors = await fixture.database.client.query(`SELECT count(*)::integer AS count
    FROM ${q(fixture.database.schemaName)}."AncestorIds" ancestor
    JOIN ${q(fixture.database.schemaName)}."BaseItems" item ON item."Id"=ancestor."ItemId"
    WHERE item."Type"=$1`, [nativeTextBytes('MediaBrowser.Controller.LiveTv.LiveTvProgram')]);
  assert.equal(ancestors.rows[0].count, 0, 'LiveTvProgram.SupportsAncestors is false even with a persisted channel and view parent.');
  const cold = await fixture.library.itemCreation.getItemById(duplicate.Id);
  assert.equal(dateTicks(cold.StartDate), dateTicks(program(0).StartDate)); assert.equal(cold.ShowId, 'persisted-show');
  assert.equal(cold.EpisodeTitle, 'Persisted episode'); assert.equal(cold.IsMovie, true); assert.equal(cold.IsRepeat, true); assert.equal(cold.IsSeries, true);
  const order = (await fixture.database.client.query(`SELECT item."Id" FROM ${q(fixture.database.schemaName)}."BaseItems" item
    JOIN ${q(fixture.database.controlSchema)}.item_order sequence ON sequence.item_id=item."Id"
    WHERE item."Type"=$1 ORDER BY sequence.position`, [nativeTextBytes('MediaBrowser.Controller.LiveTv.LiveTvProgram')])).rows.map(row => idKey(decodeNativeTextBytes(row.Id, 'runtime')));
  assert.deepEqual(order, saved.map(row => idKey(row.Id)).sort());
  assert.ok(observedPages.includes(128) && observedPages.some(count => count > 0 && count < 128));
  await assertReleased(fixture);
});

test('initial existing programs reuse one SQL slot and run real metadata savers for every updated occurrence before one save', { skip: !enabled, timeout: 240000 }, async t => {
  const fixture = await setup(t, 131), before = await rows(fixture), calls = [], original = fixture.host.updates.runMetadataSavers.bind(fixture.host.updates);
  fixture.options.updates = { async runMetadataSavers(loaded, reason) {
    calls.push({ Id: idKey(loaded.item.Id), Name: loaded.item.Name, stamp: loaded.item.DateLastSaved });
    return original(loaded, reason);
  } };
  await withGuideProgramBatch(fixture.options, async batch => {
    assert.equal(batch.counts.existing, 131n);
    const first = await batch.consume(program(0, { Name: 'First pending', Etag: 'external-v2' }));
    for (let index = 1; index < 131; index++) await batch.consume(program(index, { Name: 'Updated ' + index, Etag: 'external-v2' }));
    const last = await batch.consume(program(0, { Name: 'Last pending', Etag: 'external-v3' }));
    assert.equal(first.SlotKey, last.SlotKey); assert.equal(last.isNew, false); assert.equal(last.isUpdated, true);
    batch.seal(); assert.equal(batch.counts.updated, 132n);
    const occurrences = await viewValues(batch.updatedView); assert.equal(occurrences[0].Name, 'Last pending'); assert.equal(occurrences.at(-1).Name, 'Last pending');
    assert.deepEqual(await rows(fixture), before);
    await batch.saveNew(); assert.equal(calls.length, 0);
    await batch.saveUpdated(); assert.equal(calls.length, 132);
    assert.equal(calls[0].Name, 'Last pending'); assert.equal(calls.at(-1).Name, 'Last pending');
    const saved = await rows(fixture), lastRow = saved.find(row => idKey(row.Id) === first.Id);
    assert.equal(lastRow.Name, 'Last pending'); assert.ok(dateTicks(lastRow.DateLastSaved) > dateTicks(calls.at(-1).stamp));
  });
  await assertReleased(fixture);
});

test('a final materialization failure prevents all earlier new and updated business writes and releases partial state', { skip: !enabled, timeout: 120000 }, async t => {
  const fixture = await setup(t, 1), before = await rows(fixture);
  await assert.rejects(withGuideProgramBatch(fixture.options, async batch => {
    await batch.consume(program(0, { Name: 'Pending existing', Etag: 'changed' }));
    for (let index = 1; index < 131; index++) await batch.consume(program(index));
    let failure;
    try { await batch.consume(program(131, { Genres: null })); } catch (error) { failure = error; }
    assert.equal(failure.nativeException, 'NullReferenceException');
    assert.throws(() => batch.seal(), { nativeException: 'NullReferenceException' });
    const plan = batch.seenPlan, seen = await batch.query(`SELECT count(*) FROM (${plan.text}) prefix`, plan.values);
    assert.equal(BigInt(seen.rows[0].count), 131n);
    throw failure;
  }), { nativeException: 'NullReferenceException' });
  assert.deepEqual(await rows(fixture), before); await assertReleased(fixture);
});

test('a later program persistence constraint rolls back every earlier page and its owned relations', { skip: !enabled, timeout: 180000 }, async t => {
  const fixture = await setup(t), forbidden = nativeTextBytes('Fail later page').toString('hex');
  await fixture.database.client.query(`ALTER TABLE ${q(fixture.database.schemaName)}."BaseItems" ADD CONSTRAINT guide_late_failure
    CHECK ("Name" IS DISTINCT FROM decode('${forbidden}','hex'))`);
  await assert.rejects(withGuideProgramBatch(fixture.options, async batch => {
    for (let index = 0; index < 131; index++) await batch.consume(program(index, { Name: index === 130 ? 'Fail later page' : 'Accepted ' + index,
      ProviderIds: { Custom: String(index) }, Genres: ['Drama'], ImageUrl: 'http://fixture.invalid/' + index }));
    batch.seal(); await batch.saveNew();
  }), { code: '23514' });
  assert.equal((await rows(fixture)).length, 0);
  assert.equal((await fixture.database.rows('BaseItemProviders')).length, 0);
  assert.equal((await fixture.database.rows('BaseItemImageInfos')).length, 0);
  assert.equal((await fixture.database.rows('ItemValuesMap')).length, 0);
  await assertReleased(fixture);
});

test('updated metadata saver prefixes precede request cancellation and the final repository transaction', { skip: !enabled, timeout: 120000 }, async t => {
  const fixture = await setup(t, 2), request = new AbortController(), calls = [], files = [];
  await fixture.adapter.mkdir('/selection'); await fixture.adapter.write('/selection/program0.ts', Buffer.from('retained original media'));
  await fixture.database.update('BaseItems', { Id: guideProgramId(program(0).Id) }, { Path: 'Z:\\ChildSelection\\program0.ts' });
  const before = await rows(fixture), load = fixture.loadContext;
  fixture.options.loadContext = async (...args) => {
    const loaded = await load(...args); loaded.libraryOptions = { ...loaded.libraryOptions, MetadataSavers: ['Guide saver control'] }; return loaded;
  };
  fixture.registry.register({ id: 'guide-saver-control', name: 'Guide saver control', providers: [{ id: 'guide-saver-control',
    name: 'Guide saver control', kind: 'saver', itemTypes: ['LiveTvProgram'], isEnabledFor: () => true, validateSave: async () => {},
    async save(item, context) {
      assert.equal(context.signal, undefined);
      files.push({ Id: idKey(item.Id), oldName: (await rows(fixture)).find(row => idKey(row.Id) === idKey(item.Id)).Name });
      await fixture.adapter.write('/selection/program0.nfo', Buffer.from(item.Name));
    } }] });
  const actual = fixture.host.updates.runMetadataSavers.bind(fixture.host.updates);
  fixture.options.updates = { async runMetadataSavers(loaded, reason) { calls.push(idKey(loaded.item.Id)); return actual(loaded, reason); } };
  await assert.rejects(withGuideProgramBatch(fixture.options, async batch => {
    await batch.consume(program(0, { Name: 'File changed before cancellation', Etag: 'changed' })); await batch.consume(program(1, { Etag: 'changed' }));
    batch.seal(); await batch.saveNew(); request.abort(); await batch.saveUpdated({ signal: request.signal });
  }), { name: 'AbortError' });
  assert.equal(calls.length, 2); assert.deepEqual(files, [{ Id: guideProgramId(program(0).Id), oldName: 'Program 0' }]);
  const content = await fixture.adapter.openRead('/selection/program0.nfo');
  try { const chunks = []; for await (const chunk of content.stream) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString(), 'File changed before cancellation'); }
  finally { await content.close(); }
  assert.deepEqual(await rows(fixture), before); await assertReleased(fixture);
});
