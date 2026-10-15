import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseNfo, parseNfoAsync } from '../../plugins/nfo/parser.js';
import { applyNfoUserDataEntry } from '../../plugins/nfo/user-data-import.js';

const root = new URL('./fixtures/nfo-episode-blocks/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const layouts = await (await import('./reader-layout-fixture.js')).layoutFixture('nfo-episode-blocks');
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

async function candidate(sample, asynchronous) {
  const item = createItem(sample), calls = [];
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
      if (sample.cancelAfterSave === attempt) controller.abort();
    },
  };
  try {
    const options = { type: 'Episode', item, signal: controller.signal };
    result = asynchronous
      ? await parseNfoAsync(sample.text, { ...options,
        onUserDataImport: entry => applyNfoUserDataEntry(entry, { configuration: { UserId: userId }, store, userData }) })
      : parseNfo(sample.text, options);
    hasMetadata = true;
  } catch (caught) { error = caught; }
  return {
    exception: exceptionName(error), hasMetadata, item: projectItem(item),
    people: (result?.People ?? []).map(projectPerson),
    remoteImages: (result?.RemoteImages ?? []).map(image => ({ Url: image.Url, Type: image.Type })),
    localImages: (result?.LocalImageCandidates ?? []).map(image => ({ Path: image.Url, Type: image.Type })),
    calls, userData: { current: snapshotUserData(data), persisted },
  };
}

const core = result => ({ exception: result.exception, hasMetadata: result.hasMetadata, item: result.item,
  people: result.people, remoteImages: result.remoteImages, localImages: result.localImages });

test('native Episode block fixture binds exact inputs, sources, runtime and record', async () => {
  for (const file of Object.values(provenance.files)) {
    assert.equal(sha256(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  }
  assert.equal(process.platform, 'win32');
  assert.equal(native.schemaVersion, 1);
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.recordedAt, '2026-10-08T02:21:01.755Z');
  assert.equal(provenance.command, 'node tools/validation/oracle.js tests/metadata/fixtures/nfo-episode-blocks/Oracle.csproj D:/mediamanager-validation/20261005/results/nfo-episode-blocks-20261008-v5-final tests/metadata/fixtures/nfo-episode-blocks/input.json {output}/native.json');
  assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false);
  assert.equal(native.environment.isWindows, true);
  assert.equal(native.environment.os, 'Microsoft Windows NT 10.0.26300.0');
  assert.equal(native.environment.culture, 'zh-CN');
  assert.equal(native.environment.uiCulture, 'zh-CN');
  assert.equal(provenance.jellyfin.root, 'D:/jellyfin');
  assert.equal(provenance.jellyfin.head, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.jellyfin.relevantSourceWorktreeClean, true);
  assert.equal(native.frozenJellyfinHead, provenance.jellyfin.head);
  assert.deepEqual(Object.fromEntries(Object.entries(provenance.files).map(([name, file]) => [name, file.path])), {
    native: 'tests/metadata/fixtures/nfo-episode-blocks/native.json',
    input: 'tests/metadata/fixtures/nfo-episode-blocks/input.json',
    oracle: 'tests/metadata/fixtures/nfo-episode-blocks/Program.cs',
    project: 'tests/metadata/fixtures/nfo-episode-blocks/Oracle.csproj',
    buildProperties: 'tests/Directory.Build.props',
  });
  assert.deepEqual(Object.fromEntries(Object.entries(provenance.files).map(([name, file]) => [name, file.sha256])), {
    native: '114bf46367fb9678151749be4897e0640a8cbc7113415d0938328880df1212aa',
    input: 'a7a0b537cda84c819e5d869c39b57d0988ce6c7295bd0687d4d0949557fcb2cd',
    oracle: 'c3aaabf312a3523c462b9cbc098418b52d5ddb98f2c351598d3ee8e83b7448e7',
    project: '56e42cc99a5305248cb523db75850ab8bce9868f3a283101fa0a208332829234',
    buildProperties: 'd13564ee3d33568e7f897c6fe74ea5e71cc5ef9539e16854e628c5295c2319bd',
  });
  assert.deepEqual(provenance.jellyfin.sources, {
    'MediaBrowser.XbmcMetadata/Parsers/EpisodeNfoParser.cs': 'db512780a4880eba3d5a86de035164e8f7dc3bc63719d8eb5a50e906cb8c2105',
    'MediaBrowser.XbmcMetadata/Parsers/BaseNfoParser.cs': 'f50fd3439d423330b0bc1c40ab5b413a2c2b3811a14a0955ecd9fbb63b32c152',
    'MediaBrowser.XbmcMetadata/Providers/EpisodeNfoProvider.cs': '64a3c4cb68fb4141d282ee10948d95a09ef44859ddb6895023ad8264d333fe76',
    'MediaBrowser.XbmcMetadata/Providers/BaseNfoProvider.cs': '3e9cb414ae0efe0752c4d935988f5fce61ec30a26cc31d27b2c436580c94d8bc',
    'MediaBrowser.Controller/Providers/MetadataResult.cs': '71fb22c6a4da1e4ec2af9e872eede684af560c5f5dcf17b9dde83dd4f644d856',
    'MediaBrowser.Controller/Extensions/XmlReaderExtensions.cs': '45e5ecd70806044d4d803f2d7b9a2b9c370d9ba21c232234f2d7de61f7ca446c',
    'MediaBrowser.XbmcMetadata/Configuration/NfoConfigurationExtension.cs': 'b31130b924c80f9c506edf4bf091604584beaa80c13666b4a6c8727270e61526',
  });
  assert.equal(provenance.runtime.platform, 'win32');
  assert.equal(provenance.runtime.os, 'Microsoft Windows NT 10.0.26300.0');
  assert.equal(provenance.runtime.culture, 'zh-CN');
  assert.equal(provenance.runtime.uiCulture, 'zh-CN');
  assert.equal(provenance.runtime.timezone, 'Asia/Taipei');
  assert.equal(provenance.runtime.node, 'v24.16.0');
  assert.deepEqual(provenance.runtime.dotnet, {
    path: 'D:/mediamanager/.tools/dotnet/dotnet.exe', bytes: 167208,
    sha256: '21a46f1e5235cf4e844b9de5429f0e198b9c97a41f0503a66442f1d639ca3ee6',
  });
  assert.deepEqual(provenance.runtime.jellyfinDll, {
    path: 'D:/mediamanager-validation/20261005/jellyfin-baseline/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll',
    bytes: 506368, sha256: 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767',
  });
  assert.deepEqual(Object.fromEntries(Object.entries(provenance.runtime.assemblies).map(([name, file]) => [name, file.bytes])), {
    'MediaBrowser.XbmcMetadata.dll': 84992,
    'MediaBrowser.Controller.dll': 655872,
    'MediaBrowser.Common.dll': 48640,
    'MediaBrowser.Model.dll': 489472,
    'Emby.Server.Implementations.dll': 1673728,
    'Jellyfin.Database.Implementations.dll': 249344,
    'Jellyfin.Extensions.dll': 37888,
  });
  assert.deepEqual(Object.fromEntries(Object.entries(provenance.runtime.assemblies).map(([name, file]) => [name, file.sha256])), {
    'MediaBrowser.XbmcMetadata.dll': '82ddd82082f44faf43284258609ba4efce9a94759d24e0f7161ebf5c7d18558e',
    'MediaBrowser.Controller.dll': '051c588a8e85a3a7cdde8dc3d9a1112217fd7e973a86fe2ff90cf765bedb75a8',
    'MediaBrowser.Common.dll': 'c86a38f99a78d9d3b9dd5ba5245fb06bf654cfa3e16ec409d3ba77b1e69ed11e',
    'MediaBrowser.Model.dll': '7b2c1b16721cf7747b572e4de3761de635fad4bd12bec346983545bee73fd92c',
    'Emby.Server.Implementations.dll': '8d369435646570958505c58b9cb17da169855dabc105d0e933524361e9b7b1c8',
    'Jellyfin.Database.Implementations.dll': '5ffd9a90affb635962267da294a36a4cd6972da5f38083b51ecfb4fba4c31ee6',
    'Jellyfin.Extensions.dll': 'db952e3013a6949ad22db9ac3379be2efdf441c139ddc6919e86f8c2abbc7207',
  });
  assert.equal(provenance.record.path, 'D:/mediamanager-validation/20261005/results/nfo-episode-blocks-20261008-v5-final/record.json');
  assert.equal(provenance.record.sha256, '1beeabd9e5689a4c6a7d94cf0acaccdd403337145ccb02042c35dd3ecc125494');
  assert.equal(provenance.record.sourceFilesSha256, '7d12a7679ef5f1d81880d8990fdc63c7c8c13d92b8992378eaca67e902e6f75f');
  assert.equal(provenance.record.oracleAssemblySha256, '39844bcbe251d2653ccac394a03d8dad3f76ee67a66127d65b59a08a818c6de7');
  const portableNative = await readFile(new URL('native.json', root));
  assert.equal(provenance.record.rawNativeSha256, '114bf46367fb9678151749be4897e0640a8cbc7113415d0938328880df1212aa');
  assert.equal(provenance.record.portableNativeSha256, '114bf46367fb9678151749be4897e0640a8cbc7113415d0938328880df1212aa');
  assert.equal(provenance.record.rawNativeSha256, provenance.record.portableNativeSha256);
  assert.equal(sha256(portableNative), provenance.record.portableNativeSha256);
  assert.equal(provenance.record.rawNativeBytes, 111306);
  assert.equal(provenance.record.portableNativeBytes, 111306);
  assert.equal(portableNative.length, provenance.record.rawNativeBytes);
  assert.equal(portableNative.includes(13), false);
  assert.equal(provenance.record.rawCarriageReturns, 0);
  assert.equal(provenance.record.portableCarriageReturns, 0);
  assert.equal(portableNative.at(-1), 10);
  assert.equal(provenance.record.rawFinalByte, 10);
  assert.equal(provenance.record.portableFinalByte, 10);
  assert.equal(provenance.record.buildStatus, 0);
  assert.equal(provenance.record.processStatus, 0);
  assert.equal(input.length, 56);
  assert.equal(native.results.length, input.length);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.inputSha256, sha256(await readFile(new URL('input.json', root))));
  for (const [index, sample] of input.entries()) {
    const bytes = Buffer.from(sample.text), frozen = native.results[index];
    assert.equal(bytes.toString('base64'), frozen.raw.base64, sample.name);
    assert.equal(bytes.length, frozen.raw.bytes, sample.name);
    assert.equal(sha256(bytes), frozen.raw.sha256, sample.name);
  }
});

test('native Episode block fixture freezes split, merge, prefix and side-effect boundaries', () => {
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
  assert.deepEqual(transient.calls.map(call => `${call.action}:${call.itemId ?? ''}`), [
    `user:`, `data:${emptyId}`, `user:`, `data:${emptyId}`, `user:`, `data:${itemId}`, `save:${itemId}`,
  ]);
  assert.deepEqual(transient.userData.persisted, { Played: true, PlayCount: 2, lastPlayedDate: null });
  const xmlFailure = byName.get('xml failure after temporary userdata keeps its side effect but skips target replay');
  assert.equal(xmlFailure.hasMetadata, true);
  assert.deepEqual(xmlFailure.userData.current, { Played: true, PlayCount: 0, lastPlayedDate: null });
  assert.equal(xmlFailure.item.Name, 'Initial');
  const saveFailure = byName.get('winner save failure preserves its earlier scalar target prefix');
  assert.equal(saveFailure.exception, 'IOException');
  assert.equal(saveFailure.item.Name, 'Winner prefix');
  assert.equal(saveFailure.userData.persisted, null);
  assert.equal(byName.get('pre cancellation on an empty file is preceded by xml setup').exception, null);
  assert.equal(byName.get('pre cancellation on a self closing root sees no interactive child').exception, null);
  assert.equal(byName.get('pre cancellation on a paired empty root observes the end element').exception, 'OperationCanceledException');
  assert.equal(byName.get('malformed setup xml is swallowed before pre cancellation').exception, null);
  assert.equal(byName.get('pre cancellation in a multi block file stops in the first temporary block').exception,
    'OperationCanceledException');
  const finalSaveCancellation = byName.get('cancellation after the final winner save is observed before root completion');
  assert.equal(finalSaveCancellation.exception, 'OperationCanceledException');
  assert.deepEqual(finalSaveCancellation.userData.persisted, { Played: true, PlayCount: 0, lastPlayedDate: null });
});

test('production async Episode reader matches all frozen native results', async () => {
  const differences = [];
  for (const [index, sample] of [...input, ...layouts.input].entries()) {
    const actual = await candidate(sample, true), expected = [...native.results, ...layouts.native.results][index];
    const frozen = { exception: expected.exception, hasMetadata: expected.hasMetadata, item: expected.item,
      people: expected.people, remoteImages: expected.remoteImages, localImages: expected.localImages,
      calls: expected.calls, userData: expected.userData };
    try { assert.deepEqual(actual, frozen); } catch { differences.push({ name: sample.name, actual, expected: frozen }); }
  }
  if (process.env.MEDIAMANAGER_CAPTURE_NFO_EPISODE_DIFF === '1') {
    process.stdout.write(`NFO_EPISODE_DIFF=${JSON.stringify(differences)}\n`);
  }
  assert.deepEqual(differences, []);
});

test('production sync Episode reader matches native structural results where callbacks do not inject failures', async () => {
  const differences = [];
  for (const [index, sample] of [...input, ...layouts.input].entries()) {
    if (sample.asyncOnly) continue;
    const actual = core(await candidate(sample, false)), expected = core([...native.results, ...layouts.native.results][index]);
    try { assert.deepEqual(actual, expected); } catch { differences.push({ name: sample.name, actual, expected }); }
  }
  assert.deepEqual(differences, []);
});
