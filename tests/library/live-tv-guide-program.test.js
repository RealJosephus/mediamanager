import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { guideProgramId, materializeGuideProgram } from '../../src/library/live-tv-guide-program.js';
import { guideChannelId, materializeGuideChannel } from '../../src/library/live-tv-guide-channel.js';
import { isNativeItemEntity, newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { onMetadataChanged } from '../../src/metadata/metadata-changed.js';
import { dateTicks, idKey, MIN_DATE } from '../../src/library/records.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const channelId = 'a9600000000000000000000000000001';
const parentId = 'a9600000000000000000000000000002';
const type = 'MediaBrowser.Controller.LiveTv.LiveTvProgram';
const time = '2500-01-01T01:00:00.0000000Z', end = '2500-01-01T02:00:00.0000000Z';
const image = (Type, Path) => ({ Type, Path, DateModified: '2024-01-01T00:00:00.0000000Z', Width: 640, Height: 480, BlurHash: 'old' });

function fixture() {
  const baseInfo = { Id: 'External Show', Name: 'Old name', ShowId: 'show', StartDate: time, EndDate: end,
    OfficialRating: 'CONTROLLED', ProviderIds: { ProgramEtag: 'external-v1' }, Etag: 'external-v1' };
  const prior = { Name: 'Old name', ParentId: channelId, ChannelId: channelId, ShowId: 'show', StartDate: time, EndDate: end,
    OfficialRating: 'CONTROLLED', ProviderIds: { ProgramEtag: 'external-v1' }, DateCreated: '2025-01-01T00:00:00.0000000Z',
    DateModified: '2025-01-02T00:00:00.0000000Z', InheritedParentalRatingValue: 99, InheritedParentalRatingSubValue: 8 };
  const existing = (name, info = {}, properties = {}, extra = {}) => ({ name,
    info: { ...structuredClone(baseInfo), ...info }, existing: { ...structuredClone(prior), ...properties }, ...extra });
  const channelInfo = { Id: 'External Channel', Name: 'Old channel', Number: '7', ChannelType: 'TV', Tags: ['Kids'] };
  const channelPrior = { ParentId: parentId, ExternalId: channelInfo.Id, Name: channelInfo.Name, Number: channelInfo.Number, ChannelType: 'TV',
    ServiceName: 'Emby', ProviderIds: { ExternalServiceId: 'Emby' }, Tags: ['Kids'], DateCreated: prior.DateCreated, DateModified: prior.DateModified };
  const channelExisting = (name, info = {}, properties = {}, extra = {}) => ({ name, serviceName: 'Emby',
    info: { ...structuredClone(channelInfo), ...info }, existing: { ...structuredClone(channelPrior), ...properties }, ...extra });
  return { channelId, parentId, channelCases: [
    { name: 'new channel preserves tag alias and remote image', serviceName: 'Emby', info: { ...channelInfo, ImageUrl: 'http://fixture.invalid/channel' } },
    channelExisting('unchanged channel assigns its equivalent tags without persisting', { Tags: ['kIDS'] }),
    channelExisting('null tags preserve the existing array', { Tags: null }),
    channelExisting('tag order or value changes force create for the existing object', { Tags: ['Sports', 'Kids'] }),
    channelExisting('parent change forces create for the existing object', {}, { ParentId: channelId }),
    channelExisting('name number and external id compare ordinal', { Id: 'EXTERNAL CHANNEL', Name: 'OLD CHANNEL', Number: '7.0' }),
    channelExisting('provider id comparison ignores case but service spelling is overwritten', {}, { ProviderIds: { externalserviceid: 'EMBY' } }),
    { name: 'nonchannel identity match creates a new channel', serviceName: 'Emby', info: structuredClone(channelInfo),
      existing: { Name: 'Wrong video', ParentId: parentId, Tags: ['Kids'], DateCreated: prior.DateCreated, DateModified: prior.DateModified }, wrongType: true },
    channelExisting('remote image change mutates the original image and clears blurhash', { ImageUrl: 'HTTP://fixture.invalid/new' },
      { ImageInfos: [image('Primary', 'http://fixture.invalid/old')] }),
    channelExisting('local image metadata preserves the original blurhash', { ImagePath: '/channel/local.png', ImageUrl: 'http://fixture.invalid/trigger' },
      { ImageInfos: [image('Primary', '/old-local')] }),
    channelExisting('a changed local path alone does not refresh an existing primary', { ImagePath: '/channel/ignored.png' },
      { ImageInfos: [image('Primary', '/old-local')] }),
    channelExisting('same remote url suppresses a different preferred local path', { ImagePath: '/channel/ignored.png', ImageUrl: 'http://fixture.invalid/same' },
      { ImageInfos: [image('Primary', 'http://fixture.invalid/same')] }),
    channelExisting('remote image comparison is case sensitive', { ImageUrl: 'HTTP://FIXTURE.INVALID/SAME' },
      { ImageInfos: [image('Primary', 'http://fixture.invalid/same')] }),
    channelExisting('absent incoming image does not remove current primary', {}, { ImageInfos: [image('Primary', '/retained')] }),
    channelExisting('missing primary uses local metadata', { ImagePath: '/channel/new.png' }),
    channelExisting('file observation failure retains earlier field mutations', { ImagePath: '/channel/fail.png', Name: 'Reached name' }, {}, { fileFailure: true }),
    channelExisting('blank service fails after tags parent and channel type', { Tags: ['Sports'], ChannelType: 'Radio', Name: 'Not reached' }, {}, { serviceName: ' ' }),
    channelExisting('service provider id is trimmed independently of ServiceName', {}, {}, { serviceName: ' Emby ' }),
  ], cases: [
    { name: 'new program tags hd series provider aliases and all images', info: { ...baseInfo, Etag: ' xmltv-sha256-v1:created ',
      IsLive: true, IsPremiere: true, IsNews: true, IsSports: true, IsKids: true, IsRepeat: true, IsMovie: true, IsSeries: true, IsHD: true,
      SeriesId: 'series', EpisodeTitle: 'Pilot', Audio: 'Stereo', CommunityRating: 7.25, Genres: ['Drama', 'Drama', null],
      ProductionYear: 2500, OriginalAirDate: '2499-12-01T00:00:00.0000000Z', EpisodeNumber: 2, SeasonNumber: 1,
      ProviderIds: { IMDb: 'tt1' }, SeriesProviderIds: { Tvdb: '42', imdb: null }, ImagePath: '/mapped/poster.jpg', ImageUrl: 'http://fixture.invalid/poster',
      ThumbImageUrl: 'http://fixture.invalid/thumb', LogoImageUrl: 'http://fixture.invalid/logo', BackdropImageUrl: 'http://fixture.invalid/backdrop' } },
    existing('ordinary etag equality still applies unsaved field changes', { Name: 'Changed without force', Audio: 'DolbyDigital', CommunityRating: 8.5,
      Genres: ['News'], Overview: 'A live-only change', IsNews: true, IsPremiere: true, ProductionYear: 2499 }),
    existing('image removals alone do not request save', {}, { ImageInfos: [image('Primary', '/old-primary'), image('Thumb', '/old-thumb'),
      image('Logo', '/old-logo'), image('Backdrop', '/old-backdrop')] }),
    existing('existing images mutate their original objects', { ImagePath: '/new-primary', ThumbImageUrl: 'http://fixture.invalid/new-thumb',
      LogoImageUrl: 'http://fixture.invalid/new-logo', BackdropImageUrl: 'http://fixture.invalid/new-backdrop' },
    { ImageInfos: [image('Primary', '/old-primary'), image('Thumb', '/old-thumb'), image('Logo', '/old-logo'), image('Backdrop', '/old-backdrop')] }),
    existing('same remote url prevents replacement by a new local image path', { ImagePath: '/preferred-new-path', ImageUrl: 'HTTP://FIXTURE.INVALID/SAME' },
      { ImageInfos: [image('Primary', 'http://fixture.invalid/same')] }),
    existing('exact xmltv prefix and ignore-case stored etag skip malformed incoming collections',
      { Etag: 'xmltv-sha256-v1:ABC', Genres: null, SeriesProviderIds: null, ProviderIds: null, Name: 'Must not be assigned' },
      { ProviderIds: { programeTAG: 'XMLTV-SHA256-V1:abc' }, ImageInfos: [image('Primary', '/retained-by-fast-path')] }),
    existing('uppercase incoming prefix uses the field path', { Etag: 'XMLTV-SHA256-V1:abc', Name: 'Assigned uppercase', ProviderIds: { ProgramEtag: 'XMLTV-SHA256-V1:abc' } },
      { ProviderIds: { ProgramEtag: 'XMLTV-SHA256-V1:abc' } }),
    existing('leading whitespace prevents xmltv fast path and gets trimmed only when written', { Etag: ' xmltv-sha256-v1:abc ', Name: 'Assigned leading space',
      ProviderIds: {} }, { ProviderIds: { ProgramEtag: 'xmltv-sha256-v1:abc' } }),
    existing('different etag forces metadata change', { Etag: 'external-v2' }),
    existing('whitespace etag forces metadata without storing it', { Etag: '\u2003' }),
    existing('case-only show and series ids retain existing spelling without force', { ShowId: 'SHOW', SeriesId: 'SERIES' }, { ExternalSeriesId: 'series' }),
    existing('false hd and blank series id do not reset previous values', { IsHD: false, SeriesId: ' ', OriginalAirDate: null },
      { Width: 1920, Height: 1080, ExternalSeriesId: 'old-series', SeriesName: 'Retained series name', PremiereDate: '2490-01-01T00:00:00.0000000Z' }),
    existing('new series keeps previous premiere date', { EpisodeTitle: ' ', OriginalAirDate: '2499-01-01T00:00:00.0000000Z' },
      { PremiereDate: '2490-01-01T00:00:00.0000000Z' }),
    existing('repeat series overwrites premiere date', { IsSeries: true, IsRepeat: true, OriginalAirDate: '2499-01-01T00:00:00.0000000Z' },
      { PremiereDate: '2490-01-01T00:00:00.0000000Z' }),
    existing('null genres stop after the tag mutation', { Genres: null, Name: 'Not reached', Audio: 'Stereo', IsMovie: true,
      SeriesId: 'new-series', EpisodeTitle: 'new episode' }, { Tags: ['Retained'], Genres: ['old'], Width: 1920, Height: 1080 }),
    existing('null series provider dictionary stops after runtime and name', { SeriesProviderIds: null, Name: 'Reached before failure',
      Overview: 'Reached overview', StartDate: '2500-01-01T01:01:00.0000000Z', IsHD: true }),
    existing('null provider dictionary fails during the series writes', { ProviderIds: null, SeriesProviderIds: { Tvdb: '42' }, Name: 'Reached name' }),
    existing('null provider dictionary with empty series ids creates an item-only etag dictionary', { ProviderIds: null, Etag: 'new-etag' }),
    existing('series writes replace existing provider keys ignoring case', { ProviderIds: { seriestvdb: 'old', ProgramEtag: 'external-v1' }, SeriesProviderIds: { Tvdb: 'new' } }),
    existing('submillisecond and negative runtime remain exact', { StartDate: '2500-01-01T01:00:00.1234567Z', EndDate: '2500-01-01T00:59:59.7654321Z' }),
    existing('removing an absent image still applies native reference distinctness', {}, { ImageInfos: [image('Disc', '/unrelated-disc')] }, { duplicateImageReference: true }),
    existing('missing rating clears inherited values when metadata is requested', { OfficialRating: null, Etag: null }),
    { name: 'null external id still has a native deterministic identity', info: { Id: null, Name: null, StartDate: time, EndDate: end, Etag: null } },
  ] };
}

const ticks = value => value == null ? null : dateTicks(value).toString();
const projectImage = image => ({ Path: image.Path, Type: image.Type, DateModified: ticks(image.DateModified ?? MIN_DATE),
  Width: image.Width ?? 0, Height: image.Height ?? 0, BlurHash: image.BlurHash ?? null });
function project(item, created) {
  const fields = ['Name', 'ShowId', 'Audio', 'CommunityRating', 'EpisodeTitle', 'ExternalId', 'ExternalSeriesId', 'SeriesName', 'Tags', 'Genres',
    'Width', 'Height', 'IsMovie', 'IsRepeat', 'IsSeries', 'OfficialRating', 'Overview', 'ProviderIds', 'ProductionYear', 'IndexNumber', 'ParentIndexNumber',
    'InheritedParentalRatingValue', 'InheritedParentalRatingSubValue', 'IsVirtualItem', 'IsLive', 'IsPremiere', 'IsNews', 'IsSports', 'IsKids'];
  return { NativeType: item.NativeType, Id: idKey(item.Id), ParentId: idKey(item.ParentId), ChannelId: idKey(item.ChannelId),
    ...Object.fromEntries(fields.map(name => [name, item[name] ?? null])), RunTimeTicks: item.RunTimeTicks?.toString() ?? null,
    StartDate: ticks(item.StartDate), EndDate: ticks(item.EndDate), PremiereDate: ticks(item.PremiereDate), ImageInfos: item.ImageInfos.map(projectImage),
    DateCreated: created ? '$CREATED' : ticks(item.DateCreated), DateModified: created ? '$MODIFIED' : ticks(item.DateModified) };
}

test('guide programs match the actual private native materializer, live mutation prefixes and object aliases', { skip: !enabled, timeout: 180000 }, async () => {
  const input = fixture(), bytes = Buffer.from(JSON.stringify(input)), output = path.join(validationOutputRoot(), 'live-tv-guide-program-' + randomUUID());
  await fs.mkdir(output); const inputFile = path.join(output, 'input.json'); await fs.writeFile(inputFile, bytes, { flag: 'wx' });
  const report = { comparisons: [] }; let failure;
  try {
    const current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/Guide/GuideManager.cs', 'src/Jellyfin.LiveTv/LiveTvDtoService.cs',
      'src/Jellyfin.LiveTv/Listings/XmlTvProgramEtag.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
      'MediaBrowser.Controller/LiveTv/ProgramInfo.cs', 'MediaBrowser.Controller/LiveTv/LiveTvProgram.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
      'MediaBrowser.Controller/Entities/ItemImageInfo.cs', 'MediaBrowser.Controller/Entities/BaseItemExtensions.cs',
      'MediaBrowser.Controller/LiveTv/ChannelInfo.cs', 'MediaBrowser.Controller/LiveTv/LiveTvChannel.cs', 'MediaBrowser.Model/Entities/ProviderIdsExtensions.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/live-tv-guide-program/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json'] });
    const nativeBytes = await fs.readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(receipt.passed && native.actualPrivateGetProgram && native.actualLiveTvDtoService && native.actualLibraryIdentity);
    assert.ok(native.actualNativeEntities && native.actualMetadataChanged && native.controlledRatingLookup && native.controlledLibraryNavigation);
    assert.ok(native.actualPrivateGetChannel && native.controlledChannelPersistence && native.controlledChannelImageFileInfo);
    assert.equal(native.databaseOwnersOpened, false); assert.equal(native.executorsStarted, false);
    assert.equal(native.inputSha256, hash(bytes)); report.inputSha256 = hash(bytes); report.nativeOutputSha256 = hash(nativeBytes);
    for (const assembly of native.assemblies) assert.equal(hash(await fs.readFile(assembly.filename)), assembly.sha256);
    for (const sample of input.cases) {
      const expected = native.results.find(value => value.name === sample.name);
      const info = structuredClone(expected.initializedInfo), channel = newNativeItemEntity('MediaBrowser.Controller.LiveTv.LiveTvChannel'); channel.Id = channelId;
      const existing = sample.existing ? Object.assign(newNativeItemEntity(type), { Id: guideProgramId(info.Id) }, structuredClone(sample.existing)) : null;
      if (sample.duplicateImageReference) existing.ImageInfos = [...existing.ImageInfos, existing.ImageInfos[0]];
      const originalImages = [...existing?.ImageInfos ?? []], originalProviders = existing?.ProviderIds;
      let item = existing, isNew = null, isUpdated = null, error = null, ratingLookups = 0;
      const before = Date.now();
      try {
        const value = materializeGuideProgram(info, { existing, channel, metadataChanged(item) {
          const rating = item.CustomRating || item.OfficialRating;
          if (rating) ratingLookups++;
          return onMetadataChanged(item, rating ? { score: 12, subScore: 3 } : null);
        } });
        ({ item, isNew, isUpdated } = value);
        assert.ok(isNativeItemEntity(item));
      } catch (caught) { error = caught; }
      const after = Date.now();
      if (isNew === true) for (const name of ['DateCreated', 'DateModified']) assert.ok(Date.parse(item[name]) >= before && Date.parse(item[name]) <= after, sample.name + ' ' + name);
      const actual = { name: sample.name, id: guideProgramId(info.Id), error: error?.nativeException ?? (error instanceof TypeError ? 'NullReferenceException' : error?.name) ?? null,
        isNew, isUpdated, item: item ? project(item, isNew === true) : null, infoProviders: info.ProviderIds, infoSeriesProviders: info.SeriesProviderIds,
        providerAlias: item != null && item.ProviderIds === info.ProviderIds, preservedOriginalProviders: item != null && item.ProviderIds === originalProviders,
        originalImages: originalImages.map(image => ({ image: projectImage(image), indexInItem: item?.ImageInfos.indexOf(image) ?? -1 })),
        ratingLookups, existingDictionaryCount: existing ? 1 : 0, existingIdentity: existing != null && item === existing,
        genresCopied: item != null && info.Genres != null && item.Genres !== info.Genres };
      const comparable = { ...expected }; delete comparable.initializedInfo; delete comparable.clock;
      report.comparisons.push({ actual, expected: comparable, nativeClock: expected.clock });
      assert.deepEqual(actual, comparable, sample.name);
    }
    for (const sample of input.channelCases) {
      const expected = native.channelResults.find(value => value.name === sample.name), info = structuredClone(expected.initializedInfo);
      const existing = sample.existing ? Object.assign(newNativeItemEntity(sample.wrongType ? 'MediaBrowser.Controller.Entities.Video'
        : 'MediaBrowser.Controller.LiveTv.LiveTvChannel'), { Id: guideChannelId(sample.serviceName, info.Id) }, structuredClone(sample.existing)) : null;
      const parent = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder'); parent.Id = parentId;
      const allocated = existing?.Type !== 'LiveTvChannel', originalImages = [...existing?.ImageInfos ?? []], calls = [];
      let item = existing?.Type === 'LiveTvChannel' ? existing : null, error = null, fileDateLookups = 0;
      const before = Date.now();
      try {
        const value = await materializeGuideChannel(info, { existing, serviceName: sample.serviceName, parent, async getImageFileInfo(filename) {
          calls.push({ action: 'file-info', value: filename });
          if (sample.fileFailure) throw Object.assign(new Error('Controlled channel image observation failure.'), { nativeException: 'IOException' });
          fileDateLookups++;
          return { FullName: '/resolved' + filename, DateModified: '2024-06-01T01:02:03.0000000Z' };
        } });
        item = value.item; assert.ok(isNativeItemEntity(item));
        if (value.isNew) calls.push({ action: 'create', value: null });
        else if (value.isUpdated) calls.push({ action: 'update', value: 'MetadataImport' });
      } catch (caught) { error = caught; }
      const after = Date.now();
      if (!error && allocated) assert.ok(Date.parse(item.DateCreated) >= before && Date.parse(item.DateCreated) <= after, sample.name);
      const actual = { name: sample.name, id: guideChannelId(sample.serviceName, info.Id), error: error?.nativeException ?? error?.name ?? null,
        item: item ? { NativeType: item.NativeType, Id: idKey(item.Id), Name: item.Name, ParentId: idKey(item.ParentId), ExternalId: item.ExternalId ?? null,
          Number: item.Number, ChannelType: item.ChannelType, ServiceName: item.ServiceName, ProviderIds: item.ProviderIds, Tags: item.Tags,
          ImageInfos: item.ImageInfos.map(projectImage), DateCreated: allocated ? '$CREATED' : ticks(item.DateCreated),
          DateModified: ticks(item.DateModified), IsKids: item.IsKids } : null,
        tagAlias: item != null && item.Tags === info.Tags, existingIdentity: existing != null && item === existing,
        originalImages: originalImages.map(image => ({ image: projectImage(image), indexInItem: item?.ImageInfos.indexOf(image) ?? -1 })),
        calls, fileDateLookups, allocated };
      const comparable = { ...expected }; delete comparable.initializedInfo; delete comparable.clock;
      report.comparisons.push({ actual, expected: comparable, nativeClock: expected.clock });
      assert.deepEqual(actual, comparable, sample.name);
    }
  } catch (error) { failure = error; }
  finally { await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify({ ...report, passed: !failure, phaseAcceptance: false, releaseAcceptance: false,
    error: failure?.stack }, null, 2) + '\n'); }
  if (failure) throw failure;
});
