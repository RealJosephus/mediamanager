import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { idKey, MIN_DATE } from '../../src/library/records.js';
import { cloneNativeItemEntity } from '../../src/library/native-item-entity.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';
import { loadPostgresItemGraph } from '../../src/library/postgres-library-query.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { itemSnapshot } from '../helpers/library-exchange-state.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString,
  postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

test('owned video HTTP reads use actual part identities, version extras, visibility, order and full DTOs over PostgreSQL', {
  skip: !postgresTestConnectionString, timeout: 90000,
}, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mediamanager-additional-parts-')));
  const output = path.join(validationOutputRoot(), 'video-additional-parts-' + randomUUID());
  await mkdir(output);
  const report = { scope: { actualNodeHttp: true, actualPostgres: true, actualNativeHttp: false }, requests: [], diagnostics: [], cleanup: [] };
  const secrets = new Set([postgresTestConnectionString]), programDataPath = path.join(root, 'program');
  let database, runtime;
  t.after(async () => {
    const failures = [];
    for (const [label, close] of [
      ['runtime', async () => { const listeners = runtime?.networkHost.listeners ?? []; await runtime?.close();
        assert.ok(listeners.every(listener => !listener.server.listening)); }],
      ['postgres', () => dropPostgresTestDatabase(database)],
      ['private-root', async () => {
        assert.equal(path.dirname(root), await realpath(tmpdir()));
        assert.ok(path.basename(root).startsWith('mediamanager-additional-parts-'));
        await rm(root, { recursive: true, force: true });
      }],
    ]) {
      try { await close(); report.cleanup.push({ label, closed: true }); }
      catch (error) { failures.push(error); report.cleanup.push({ label, closed: false, message: error?.message }); }
    }
    // Diagnostic publication cannot replace a real business or close failure.
    try { await writeFile(path.join(output, 'report.json'), filterEvidenceJson(report, secrets)); }
    catch (error) { t.diagnostic('AdditionalParts report publication failed: ' + String(error?.message)); }
    if (failures.length) throw new AggregateError(failures, 'AdditionalParts owners failed to close.');
  });
  database = await createPostgresTestDatabase(null, 'additional_parts');
  runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath: path.join(root, 'config'),
    configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', EnableCaseSensitiveItemIds: true },
    serverId: randomUUID().replaceAll('-', ''),
    onError: error => report.diagnostics.push({ message: error?.message, code: error?.code, status: error?.status,
      name: error?.name, stack: error?.stack }) });
  const password = randomUUID(); secrets.add(password);
  const users = {};
  for (const [key, administrator] of [['admin', true], ['reader', false]]) {
    const created = await runtime.users.createUser({ Name: 'Parts ' + key, Password: password });
    const user = await runtime.users.getUser(created.Id);
    await runtime.users.updatePolicy(user.Id, { ...user.Policy, IsAdministrator: administrator, EnableAllFolders: true,
      BlockedTags: administrator ? [] : ['hidden'] });
    users[key] = await runtime.users.getUser(created.Id);
  }
  const tokens = {};
  for (const key of Object.keys(users)) {
    const login = await runtime.authentication.login({ Username: users[key].Username, Pw: password }, {
      Client: 'AdditionalParts consumer', Device: 'Isolated', DeviceId: 'additional-parts-' + key, Version: '1',
    }, { remoteEndPoint: '127.0.0.1' });
    tokens[key] = login.AccessToken; secrets.add(tokens[key]);
  }
  tokens.apiKey = (await runtime.apiKeys.create('AdditionalParts consumer')).AccessToken; secrets.add(tokens.apiKey);
  const mediaRoot = path.join(root, 'declared-media'), sourcePaths = Object.fromEntries(
    ['alpha', 'zeta', 'hidden', 'missing', 'wrongType', 'partOnly', 'tieFirst', 'tieSecond'].map(key => [key, path.join(mediaRoot, key + ' "版本".mkv')]));
  const ids = Object.fromEntries(Object.entries(sourcePaths).map(([key, filename]) => [key, nativeGuid(getNewItemId(filename,
    'MediaBrowser.Controller.Entities.Video', { programDataPath, enableCaseSensitiveItemIds: true }))]));
  for (const key of ['movie', 'hiddenMovie', 'book', 'decoy', 'alternate', 'partOnlyMovie',
    'trailerAlpha', 'trailerZeta', 'trailerHidden', 'trailerPart', 'trailerAlphaHidden']) ids[key] = nativeGuid(randomUUID());
  const paths = [sourcePaths.zeta, sourcePaths.missing, sourcePaths.wrongType, sourcePaths.alpha,
    sourcePaths.zeta, sourcePaths.hidden, sourcePaths.tieSecond, sourcePaths.tieFirst];
  const row = (key, type, values = {}) => postgresTestRow('BaseItems', {
    Id: ids[key], Type: 'MediaBrowser.Controller.Entities.' + type, Name: key, CleanName: key,
    SortName: key, Path: sourcePaths[key] ?? path.join(mediaRoot, key + '.mkv'),
    MediaType: type === 'Book' ? 'Book' : 'Video', IsFolder: false, IsMovie: type === 'Movies.Movie',
    PresentationUniqueKey: idKey(ids[key]), DateCreated: MIN_DATE, DateModified: MIN_DATE,
    DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE, Data: JSON.stringify({ FixtureUnknown: { retained: true } }),
    ...values,
  });
  for (const item of [
    row('movie', 'Movies.Movie', { Data: JSON.stringify({ AdditionalParts: paths, FixtureUnknown: { retained: true } }) }),
    row('hiddenMovie', 'Movies.Movie', { Tags: 'hidden', Data: JSON.stringify({ AdditionalParts: [sourcePaths.alpha] }) }),
    row('book', 'Book'), row('alpha', 'Video', { Overview: 'Complete alpha overview', OwnerId: null,
      Data: JSON.stringify({ HasSubtitles: true, FixtureUnknown: { retained: true } }) }),
    row('zeta', 'Video', { OwnerId: ids.movie }), row('hidden', 'Video', { OwnerId: ids.movie, Tags: 'hidden' }),
    row('tieFirst', 'Video', { OwnerId: ids.movie, SortName: 'tied', ForcedSortName: 'tied' }),
    row('tieSecond', 'Video', { OwnerId: ids.movie, SortName: 'tied', ForcedSortName: 'tied' }),
    row('wrongType', 'Book'), row('decoy', 'Video', { Path: sourcePaths.missing, OwnerId: ids.movie }),
    row('alternate', 'Movies.Movie', { OwnerId: ids.movie, PrimaryVersionId: ids.movie }),
    row('trailerAlpha', 'Trailer', { OwnerId: ids.movie, ExtraType: 2, SortName: 'alpha trailer', Overview: 'Full trailer overview' }),
    row('trailerZeta', 'Trailer', { OwnerId: ids.alternate, ExtraType: 2, SortName: 'zeta trailer' }),
    row('trailerHidden', 'Trailer', { OwnerId: ids.movie, ExtraType: 2, SortName: 'hidden trailer', Tags: 'hidden' }),
    row('partOnlyMovie', 'Movies.Movie', { Data: JSON.stringify({ AdditionalParts: [sourcePaths.partOnly] }) }),
    row('partOnly', 'Video', { OwnerId: ids.partOnlyMovie }),
    row('trailerPart', 'Trailer', { OwnerId: ids.partOnly, ExtraType: 2 }),
    row('trailerAlphaHidden', 'Trailer', { OwnerId: ids.alpha, ExtraType: 2, Tags: 'hidden' }),
  ]) await database.insert('BaseItems', item);
  await database.insert('LinkedChildren', { ParentId: ids.movie, ChildId: ids.alternate, ChildType: 2, SortOrder: 0 });
  const hiddenTagId = nativeGuid(randomUUID());
  await database.insert('ItemValues', { ItemValueId: hiddenTagId, Type: 4, Value: 'hidden', CleanValue: 'hidden' });
  for (const key of ['hidden', 'hiddenMovie', 'trailerHidden', 'trailerAlphaHidden']) {
    await database.insert('ItemValuesMap', { ItemId: ids[key], ItemValueId: hiddenTagId });
  }
  await database.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', {
    Id: nativeGuid(randomUUID()), ItemId: ids.movie, ImageType: 4, Path: path.join(mediaRoot, 'owner-logo.png'),
    DateModified: MIN_DATE, Width: 3, Height: 2, Blurhash: Buffer.from('owned-logo'),
  }));
  await runtime.userData.setFavorite(users.admin.Id, idKey(ids.alpha), true);
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  const request = async (name, itemId = ids.movie, { identity = 'admin', suffix = '', method = 'GET', endpoint = 'parts' } = {}) => {
    const token = identity === 'anonymous' ? undefined : identity === 'invalid' ? 'invalid-parts-token' : tokens[identity];
    const route = (endpoint === 'parts' ? '/Videos/' + itemId + '/AdditionalParts' : '/Items/' + itemId + '/LocalTrailers') + suffix;
    const response = await fetch(origin + route, { method, signal: AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
      headers: { Accept: 'application/json', ...(token ? { Authorization: `MediaBrowser Token="${token}"` } : {}) } });
    const text = await response.text(), headers = Object.fromEntries(response.headers);
    const observation = { name, route, method, identity, status: response.status, headers, bodyText: text,
      ...(headers['content-type']?.includes('json') && text ? { body: JSON.parse(text) } : {}) };
    report.requests.push(observation); return observation;
  };
  const snapshotIds = Object.values(ids).filter(id => id !== ids.missing);
  report.before = await itemSnapshot(database, snapshotIds);
  const all = await request('administrator full parts'); assert.equal(all.status, 200);
  const expected = [ids.alpha, ids.hidden, ids.tieSecond, ids.tieFirst, ids.zeta, ids.zeta].map(idKey);
  assert.deepEqual(all.body.Items.map(item => item.Id), expected);
  assert.equal(all.body.TotalRecordCount, expected.length); assert.equal(all.body.StartIndex, 0);
  for (const part of all.body.Items) {
    assert.equal(part.Type, 'Video'); assert.equal(part.ParentLogoItemId, idKey(ids.movie));
    assert.equal(typeof part.ParentLogoImageTag, 'string');
    assert.ok(Array.isArray(part.MediaSources)); assert.ok(Array.isArray(part.MediaStreams));
    assert.equal(part.MediaSources[0].Id, part.Id);
  }
  assert.equal(all.body.Items[0].Overview, 'Complete alpha overview');
  assert.equal(all.body.Items[0].HasSubtitles, true);
  assert.equal(all.body.Items[0].LocalTrailerCount, 1);
  assert.equal(all.body.Items[0].UserData.IsFavorite, true);
  const ignored = await request('controller does not accept paging or DTO query overrides', ids.movie, {
    suffix: '?fields=Name&limit=1&startIndex=1&sortBy=Name&sortOrder=Descending&enableImages=false&enableUserData=false',
  });
  assert.equal(ignored.status, 200); assert.deepEqual(ignored.body, all.body);
  const reader = await request('part visibility and selected user data', ids.movie, { identity: 'reader' });
  assert.equal(reader.status, 200); assert.deepEqual(reader.body.Items.map(item => item.Id),
    [ids.alpha, ids.tieSecond, ids.tieFirst, ids.zeta, ids.zeta].map(idKey));
  assert.equal(reader.body.Items[0].UserData.IsFavorite, false);
  assert.equal(reader.body.Items[0].LocalTrailerCount, 1, 'Native DTO counts extras without the reader filter.');
  const selected = await request('administrator selects real reader', ids.movie, { suffix: '?userId=' + users.reader.Id });
  assert.equal(selected.status, 200); assert.deepEqual(selected.body, reader.body);
  const userless = await request('API key without a user', ids.movie, { identity: 'apiKey' });
  assert.equal(userless.status, 200); assert.deepEqual(userless.body.Items.map(item => item.Id), expected);
  assert.ok(userless.body.Items.every(item => !Object.hasOwn(item, 'UserData')));
  const missingUser = await request('unknown selected user has no user data', ids.movie, { suffix: '?userId=' + randomUUID() });
  assert.equal(missingUser.status, 200); assert.deepEqual(missingUser.body, userless.body);
  for (const [name, itemId, options, status] of [
    ['anonymous', ids.movie, { identity: 'anonymous' }, 401],
    ['invalid token', ids.movie, { identity: 'invalid' }, 401],
    ['reader cannot select administrator', ids.movie, { identity: 'reader', suffix: '?userId=' + users.admin.Id }, 403],
    ['hidden parent', ids.hiddenMovie, { identity: 'reader' }, 404],
    ['missing parent', randomUUID(), {}, 404],
    ['invalid parent GUID', 'bad-guid', {}, 400],
    ['invalid selected user GUID', ids.movie, { suffix: '?userId=bad-guid' }, 400],
    ['HEAD has no action', ids.movie, { method: 'HEAD' }, 405],
  ]) assert.equal((await request(name, itemId, options)).status, status, name);
  for (const [name, itemId, options] of [
    ['non-Video parent', ids.book, {}],
    ['user root selector', '0'.repeat(32), {}],
    ['global root selector', '0'.repeat(32), { identity: 'apiKey' }],
  ]) {
    const empty = await request(name, itemId, options); assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  }
  const trailerRequest = (name, itemId, options = {}) => request(name, itemId, { endpoint: 'trailers', ...options });
  const trailers = await trailerRequest('complete trailers include actual local alternate owners', ids.movie);
  assert.equal(trailers.status, 200);
  assert.deepEqual(trailers.body.map(item => item.Id), [ids.trailerAlpha, ids.trailerHidden, ids.trailerZeta].map(idKey));
  assert.equal(trailers.body[0].Overview, 'Full trailer overview');
  for (const trailer of trailers.body) {
    assert.equal(trailer.Type, 'Trailer'); assert.ok(Array.isArray(trailer.MediaSources));
    assert.equal(trailer.ParentLogoItemId, idKey(ids.movie));
  }
  const readerTrailers = await trailerRequest('trailers apply repository tag visibility', ids.movie, { identity: 'reader' });
  assert.equal(readerTrailers.status, 200);
  assert.deepEqual(readerTrailers.body.map(item => item.Id), [ids.trailerAlpha, ids.trailerZeta].map(idKey));
  const hiddenPartTrailer = await trailerRequest('counted part trailer still obeys the public reader filter', ids.alpha, { identity: 'reader' });
  assert.equal(hiddenPartTrailer.status, 200); assert.deepEqual(hiddenPartTrailer.body, []);
  const keyReaderTrailers = await trailerRequest('API key explicitly selects a trailer reader', ids.movie,
    { identity: 'apiKey', suffix: '?userId=' + users.reader.Id });
  assert.equal(keyReaderTrailers.status, 200); assert.deepEqual(keyReaderTrailers.body, readerTrailers.body);
  const noExtras = await trailerRequest('primary does not borrow its actual part extras', ids.partOnlyMovie);
  assert.equal(noExtras.status, 200); assert.deepEqual(noExtras.body, []);
  const partExtras = await trailerRequest('actual part keeps its own extras', ids.partOnly);
  assert.equal(partExtras.status, 200); assert.deepEqual(partExtras.body.map(item => item.Id), [idKey(ids.trailerPart)]);
  for (const [name, itemId, options, status] of [
    ['trailer API key without selected user', ids.movie, { identity: 'apiKey' }, 400],
    ['trailer unknown selected user', ids.movie, { suffix: '?userId=' + randomUUID() }, 404],
    ['trailer user cannot select administrator', ids.movie, { identity: 'reader', suffix: '?userId=' + users.admin.Id }, 403],
    ['trailer hidden parent', ids.hiddenMovie, { identity: 'reader' }, 404],
    ['trailer missing parent', randomUUID(), {}, 404],
    ['trailer anonymous', ids.movie, { identity: 'anonymous' }, 401],
    ['trailer invalid token', ids.movie, { identity: 'invalid' }, 401],
    ['trailer invalid GUID', 'bad-guid', {}, 400],
    ['trailer HEAD has no action', ids.movie, { method: 'HEAD' }, 405],
  ]) assert.equal((await trailerRequest(name, itemId, options)).status, status, name);
  const trailerRoot = await trailerRequest('trailer empty GUID selects actual user root', '0'.repeat(32));
  assert.equal(trailerRoot.status, 200); assert.deepEqual(trailerRoot.body, []);
  await runtime.library.store.run(async session => {
    const state = await runtime.library.load(session, null, { baseRows: await loadPostgresItemGraph(session, [ids.movie, ids.partOnly]) });
    let cohort, failed = false, failure;
    const owner = state.byId.get(idKey(ids.movie)), originalPrimary = owner.PrimaryVersionId;
    try {
      const captured = cloneNativeItemEntity(owner);
      captured.PrimaryVersionId = ids.partOnly;
      cohort = await createNativeItemCohort({ linkedChildren: runtime.library.options.linkedChildren });
      const slots = await cohort.captureSlots([owner, captured]);
      await session.update('BaseItems', { Id: ids.movie }, { PrimaryVersionId: ids.partOnly });
      report.capturedOwnerCounts = { persisted: await session.rows('BaseItems', { where: { Id: ids.movie },
        columns: ['Id', 'Type', 'PrimaryVersionId'] }), selected: [] };
      const options = dtoOptions({ fields: ['LocalTrailerCount', 'SpecialFeatureCount'], enableimages: false, enableuserdata: false });
      await cohort.withSlots(slots, async selected => {
        const dto = await projectItem(selected, state, null, options, runtime.library.options);
        report.capturedOwnerCounts.selected.push({ Id: selected.Id, NativeType: selected.NativeType,
          PrimaryVersionId: selected.PrimaryVersionId, dto });
      });
      assert.equal(idKey(report.capturedOwnerCounts.persisted[0].PrimaryVersionId), idKey(ids.partOnly));
      assert.equal(report.capturedOwnerCounts.selected[0].dto.LocalTrailerCount, 3,
        'The captured receiver retains its own primary selection after the actual PostgreSQL row changes.');
      assert.equal(report.capturedOwnerCounts.selected[1].dto.LocalTrailerCount, 4,
        'The other captured receiver adds its real primary extras in the same DTO state.');
    } catch (error) { failed = true; failure = error; throw error; }
    finally {
      const errors = [];
      for (const close of [() => session.update('BaseItems', { Id: ids.movie }, { PrimaryVersionId: originalPrimary }),
        () => cohort?.release(), () => state.dispose({ session })]) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors,
        failure?.message ?? 'Captured DTO count resources failed to close.', failed ? { cause: failure } : undefined);
    }
  });
  report.after = await itemSnapshot(database, snapshotIds);
  assert.deepEqual(report.after, report.before, 'All HTTP reads preserve complete item values, ordered relationships and user histories.');
  report.passed = true;
});
