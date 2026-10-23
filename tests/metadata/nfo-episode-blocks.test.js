import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNfo, parseNfoAsync } from '../../plugins/nfo/parser.js';
import { applyNfoUserDataEntry } from '../../plugins/nfo/user-data-import.js';
import { currentXmlReaderFixture, functionalEpisode } from './xml-reader-current-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const fixture = await currentXmlReaderFixture(new URL('./fixtures/nfo-episode-blocks/current-profile.json', import.meta.url));
const { input, baseInput, layoutInput } = fixture;
const emptyId = '00000000-0000-0000-0000-000000000000';
const itemId = '20000000-0000-0000-0000-000000000001';
const userId = '10000000-0000-0000-0000-000000000001';

const nullable = value => value ?? null;
const oracleDate = value => {
  if (value == null) return null;
  const [seconds, fraction = ''] = (value instanceof Date ? value.toISOString() : String(value)).replace(' ', 'T').replace(/Z$/u, '').split('.');
  return `${seconds}.${fraction.padEnd(7, '0').slice(0, 7)}Z`;
};
const snapshotUserData = data => ({ Played: data.Played, PlayCount: data.PlayCount, lastPlayedDate: oracleDate(data.LastPlayedDate) });

function createItem(sample) {
  return {
    Type: 'Episode', Id: sample.existingId ? itemId : emptyId, ProviderIds: { ...(sample.initialProviderIds ?? {}) },
    ...(sample.initialName == null ? {} : { Name: sample.initialName }),
    ...(sample.initialOriginalTitle == null ? {} : { OriginalTitle: sample.initialOriginalTitle }),
    ...(sample.initialOverview == null ? {} : { Overview: sample.initialOverview }),
    ...(sample.initialSeriesName == null ? {} : { SeriesName: sample.initialSeriesName }),
    ...(sample.initialIndexNumber == null ? {} : { IndexNumber: sample.initialIndexNumber }),
    ...(sample.initialIndexNumberEnd == null ? {} : { IndexNumberEnd: sample.initialIndexNumberEnd }),
    ...(sample.initialParentIndexNumber == null ? {} : { ParentIndexNumber: sample.initialParentIndexNumber }),
    ...(sample.initialAirsBeforeEpisodeNumber == null ? {} : { AirsBeforeEpisodeNumber: sample.initialAirsBeforeEpisodeNumber }),
    ...(sample.initialAirsAfterSeasonNumber == null ? {} : { AirsAfterSeasonNumber: sample.initialAirsAfterSeasonNumber }),
    ...(sample.initialAirsBeforeSeasonNumber == null ? {} : { AirsBeforeSeasonNumber: sample.initialAirsBeforeSeasonNumber }),
  };
}

function projectItem(item) {
  const providers = Object.fromEntries(Object.entries(item.ProviderIds ?? {})
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  return {
    id: item.Id ?? emptyId,
    Name: nullable(item.Name), OriginalTitle: nullable(item.OriginalTitle), Overview: nullable(item.Overview),
    IndexNumber: nullable(item.IndexNumber), IndexNumberEnd: nullable(item.IndexNumberEnd),
    ParentIndexNumber: nullable(item.ParentIndexNumber), AirsBeforeEpisodeNumber: nullable(item.AirsBeforeEpisodeNumber),
    AirsAfterSeasonNumber: nullable(item.AirsAfterSeasonNumber), AirsBeforeSeasonNumber: nullable(item.AirsBeforeSeasonNumber),
    SeriesName: nullable(item.SeriesName), ProductionYear: nullable(item.ProductionYear),
    CommunityRating: nullable(item.CommunityRating), CriticRating: nullable(item.CriticRating),
    runTimeTicks: item.RunTimeTicks == null ? null : String(item.RunTimeTicks),
    premiereDate: oracleDate(item.PremiereDate), endDate: oracleDate(item.EndDate),
    OfficialRating: nullable(item.OfficialRating), CustomRating: nullable(item.CustomRating), Tagline: nullable(item.Tagline),
    IsLocked: item.IsLocked ?? false, lockedFields: item.LockedFields ?? [], productionLocations: item.ProductionLocations ?? [],
    genres: item.Genres ?? [], studios: item.Studios ?? [], tags: item.Tags ?? [], AspectRatio: nullable(item.AspectRatio),
    Width: item.Width ?? 0, Height: item.Height ?? 0, HasSubtitles: item.HasSubtitles ?? false, providers,
  };
}

function projectPerson(person) {
  return { Name: person.Name, Type: person.Type, Role: nullable(person.Role), SortOrder: nullable(person.SortOrder), ImageUrl: nullable(person.ImageUrl) };
}

function exceptionName(error) {
  if (!error) return null;
  if (error.name === 'XmlError') return 'XmlException';
  if (error.name === 'AbortError') return 'OperationCanceledException';
  return error.nativeException ?? error.name ?? error.constructor.name;
}

async function candidate(sample, asynchronous, file) {
  const text = (await fixture.readNativeInput(file)).toString('utf8');
  const item = createItem(sample), calls = [], committed = [];
  const data = { Played: false, PlayCount: 0, LastPlayedDate: null };
  const controller = new AbortController();
  if (sample.cancelBefore) controller.abort();
  let result, error = null, hasMetadata = false, userCalls = 0, dataCalls = 0, saves = 0, persisted = null;
  const store = { run: callback => callback({ rows: async table => {
    assert.equal(table, 'Users');
    const attempt = ++userCalls;
    calls.push({ action: 'user', attempt, id: userId });
    if (sample.failUserAt === attempt) throw Object.assign(new Error('Injected user lookup failure.'), { name: 'IOException' });
    return [{ Id: userId }];
  } }) };
  const readData = entryItem => {
    const attempt = ++dataCalls;
    calls.push({ action: 'data', attempt, itemId: entryItem.Id, value: snapshotUserData(data) });
    if (sample.failDataAt === attempt) throw Object.assign(new Error('Injected user-data read failure.'), { name: 'IOException' });
    if (sample.cancelAfterData === attempt) controller.abort();
  };
  const userData = {
    readTransient: async (_configuredUserId, entryItem) => { readData(entryItem); return data; },
    mutate: async (_configuredUserId, entryItem, mutate, reason) => {
      readData(entryItem);
      mutate(data);
      const attempt = ++saves;
      calls.push({ action: 'save', attempt, itemId: entryItem.Id, reason, tokenCanBeCanceled: false,
        tokenIsCancellationRequested: false, value: snapshotUserData(data) });
      if (sample.failSaveAt === attempt) throw Object.assign(new Error('Injected user-data save failure.'), { name: 'IOException' });
      persisted = snapshotUserData(data);
      committed.push({ itemId: entryItem.Id, reason, value: persisted });
      if (sample.cancelAfterSave === attempt) controller.abort();
    },
  };
  try {
    const options = { type: 'Episode', item, signal: controller.signal };
    result = asynchronous
      ? await parseNfoAsync(text, { ...options,
        onUserDataImport: entry => applyNfoUserDataEntry(entry, { configuration: { UserId: userId }, store, userData }) })
      : parseNfo(text, options);
    hasMetadata = true;
  } catch (caught) { error = caught; }
  return {
    exception: exceptionName(error), hasMetadata, item: projectItem(item),
    people: (result?.People ?? []).map(projectPerson),
    remoteImages: (result?.RemoteImages ?? []).map(image => ({ Url: image.Url, Type: image.Type })),
    localImages: (result?.LocalImageCandidates ?? []).map(image => ({ Path: image.Url, Type: image.Type })),
    calls, userData: { current: snapshotUserData(data), persisted, committed },
  };
}

const core = result => ({ exception: result.exception, hasMetadata: result.hasMetadata, item: result.item,
  people: result.people, remoteImages: result.remoteImages, localImages: result.localImages });

test('current Episode reader binds all 56 base cases and 168 layouts to actual Native input files', async () => {
  const { native, report } = await fixture.capture();
  assert.equal(report.nativeExecutionRecorded, true);
  assert.equal(baseInput.length, 56); assert.equal(layoutInput.length, 168);
  assert.equal(native.results.length, 224);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  await fixture.compareLayouts();
});
test('current native Episode blocks retain split, merge, failure prefix and side-effect boundaries', async () => {
  const { native } = await fixture.capture();
  const byName = new Map(native.results.map(result => [result.name, result]));
  assert.equal(byName.get('one complete block ignores a trailing partial block').item.Name, 'Complete');
  assert.equal(byName.get('three blocks sort and merge in ascending episode order').item.Name, 'First / Second / Third');
  assert.equal(byName.get('equal episode numbers retain source order').item.Name, 'First tie / Second tie');
  assert.equal(byName.get('missing episode number sorts after numbered blocks').item.Name, 'Numbered / Missing');
  assert.equal(byName.get('malformed later complete block aborts the merge without target replay').item.Name, 'Initial');
  assert.equal(byName.get('missing winning strings still receive leading merge separators').item.Name, ' / Second');
  assert.deepEqual(byName.get('winning provider identifiers are retained').item.providers, { Imdb: 'tt0000101', Tmdb: '101' });
  assert.deepEqual(byName.get('additional provider identifiers do not merge').item.providers, { Tvdb: '303' });
  const collections = byName.get('winner people and remote image survive while additional collections are discarded');
  assert.deepEqual(collections.people.map(person => person.Name), ['Winner Actor']);
  assert.deepEqual(collections.remoteImages.map(image => image.Url), ['https://example.test/winner.jpg']);
  const transient = byName.get('multi block existing item saves only winner after transient passes');
  assert.deepEqual(functionalEpisode(transient).saves, [{ itemId, reason: 'Import',
    value: { Played: true, PlayCount: 2, lastPlayedDate: null } }]);
  assert.deepEqual(transient.userData.committed, functionalEpisode(transient).saves);
  assert.deepEqual(transient.userData.persisted, { Played: true, PlayCount: 2, lastPlayedDate: null });
  const xmlFailure = byName.get('xml failure after temporary userdata keeps its side effect but skips target replay');
  assert.equal(xmlFailure.hasMetadata, true);
  assert.deepEqual(xmlFailure.userData.current, { Played: true, PlayCount: 0, lastPlayedDate: null });
  assert.equal(xmlFailure.item.Name, 'Initial');
  const saveFailure = byName.get('winner save failure preserves its earlier scalar target prefix');
  assert.equal(Boolean(saveFailure.exception), true);
  assert.equal(saveFailure.item.Name, 'Winner prefix');
  assert.equal(saveFailure.userData.persisted, null);
  assert.equal(byName.get('pre cancellation on an empty file is preceded by xml setup').exception, null);
  assert.equal(byName.get('pre cancellation on a self closing root sees no interactive child').exception, null);
  assert.equal(Boolean(byName.get('pre cancellation on a paired empty root observes the end element').exception), true);
  assert.equal(byName.get('malformed setup xml is swallowed before pre cancellation').exception, null);
  assert.equal(Boolean(byName.get('pre cancellation in a multi block file stops in the first temporary block').exception), true);
  const finalSaveCancellation = byName.get('cancellation after the final winner save is observed before root completion');
  assert.equal(Boolean(finalSaveCancellation.exception), true);
  assert.deepEqual(finalSaveCancellation.userData.persisted, { Played: true, PlayCount: 0, lastPlayedDate: null });
});

test('production async Episode reader matches all current Native files and observable side effects', async () => {
  const { native } = await fixture.capture();
  const differences = [], observations = [];
  for (const [index, sample] of input.entries()) {
    const expected = native.results[index], actual = await candidate(sample, true, expected.file);
    const expectedValues = { exception: expected.exception, hasMetadata: expected.hasMetadata, item: expected.item,
      people: expected.people, remoteImages: expected.remoteImages, localImages: expected.localImages,
      calls: expected.calls, userData: expected.userData };
    observations.push({ name: sample.name, file: expected.file, ...actual });
    try { assert.deepEqual(functionalEpisode(actual), functionalEpisode(expectedValues)); }
    catch { differences.push({ name: sample.name, actual, expected: expectedValues }); }
  }
  await fixture.recordCandidate('async', observations);
  if (process.env.MEDIAMANAGER_CAPTURE_NFO_EPISODE_DIFF === '1') {
    process.stdout.write(`NFO_EPISODE_DIFF=${JSON.stringify(differences)}\n`);
  }
  assert.deepEqual(differences, []);
});

test('production sync Episode reader matches current Native values where callbacks do not inject failures', async () => {
  const { native } = await fixture.capture();
  const differences = [], observations = [];
  for (const [index, sample] of input.entries()) {
    if (sample.asyncOnly) continue;
    const reference = native.results[index];
    const actual = core(await candidate(sample, false, reference.file)), expected = core(reference);
    observations.push({ name: sample.name, file: reference.file, ...actual });
    try { assert.deepEqual(functionalEpisode(actual), functionalEpisode(expected)); }
    catch { differences.push({ name: sample.name, actual, expected }); }
  }
  await fixture.recordCandidate('sync', observations);
  assert.deepEqual(differences, []);
});
