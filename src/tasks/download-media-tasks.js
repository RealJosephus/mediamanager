import { md5Guid } from '../core/identity.js';
import { itemLibraryOptions } from '../library/options.js';
import { normalizeLanguage } from '../library/media-streams.js';
import { sameId } from '../library/records.js';
import { movieNativeType } from '../library/video-file-resolver.js';
import { searchRemoteSubtitles } from '../playback/remote-subtitles.js';
import { downloadSubtitle, subtitleDestinations } from '../playback/subtitle-storage.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { probeCompleteMedia } from '../storage/probe-lifecycle.js';
import { nativeGuid } from '../users/native.js';
import { ScheduledTaskWorker } from './refresh-library-task.js';

const tasks = {
  DownloadLyrics: { type: 'MediaBrowser.Providers.Lyric.LyricScheduledTask', resource: 'TaskDownloadMissingLyrics',
    name: 'Download missing lyrics', description: 'Downloads lyrics for songs', provider: 'lyric', mediaType: 'Audio',
    itemTypes: ['MediaBrowser.Controller.Entities.Audio.Audio'] },
  DownloadSubtitles: { type: 'MediaBrowser.Providers.MediaInfo.SubtitleScheduledTask', resource: 'TaskDownloadMissingSubtitles',
    name: 'Download missing subtitles', description: 'Searches the internet for missing subtitles based on metadata configuration.',
    provider: 'subtitle', mediaType: 'Video', itemTypes: [movieNativeType, 'MediaBrowser.Controller.Entities.TV.Episode'] },
};

async function downloadLyrics(services, item, options, signal) {
  const existing = await services.store.run(db => db.rows('MediaStreamInfos', {
    columns: ['StreamIndex'], where: { ItemId: nativeGuid(item.Id), StreamType: 5 }, limit: 1,
  }), { signal });
  if (existing.length) return;
  const [result] = await services.lyrics.search(item, { signal, isAutomated: true, libraryOptions: options });
  signal.throwIfAborted();
  if (result) await services.lyrics.download(item, result.Id, { signal });
}

async function downloadSubtitles(services, item, options, providers, signal, onError) {
  const languages = options.SubtitleDownloadLanguages;
  if (!languages?.length || item.VideoType && item.VideoType !== 'VideoFile' || !probeCompleteMedia(item)) return;
  const sources = await services.library.getMediaSources(item.Id);
  const streams = sources.find(source => sameId(source.Id, item.Id))?.MediaStreams ?? [];
  const all = sources.flatMap(source => source.MediaStreams ?? []);
  const matches = (codes, stream) => codes.some(code => ordinalIgnoreCaseEquals(code, stream.Language ?? ''));
  // Repository eligibility also inspects alternate versions. Once selected, the
  // native downloader considers every configured language on this video itself.
  if (!languages.some(language => {
    const codes = normalizeLanguage(language);
    const has = stream => matches(codes, stream) || codes.includes('und') && !stream.Language;
    return !all.some(stream => has(stream) && (stream.Type === 'Audio' && options.SkipSubtitlesIfAudioTrackMatches
      || stream.Type === 'Subtitle' && (stream.IsExternal || options.SkipSubtitlesIfEmbeddedSubtitlesPresent)));
  })) return;
  const audio = streams.filter(stream => stream.Type === 'Audio');
  const defaults = audio.some(stream => stream.IsDefault) ? audio.filter(stream => stream.IsDefault) : audio.slice(0, 1);
  let downloaded = false;
  for (const language of languages) {
    signal.throwIfAborted();
    const codes = normalizeLanguage(language);
    if (streams.some(stream => stream.Type === 'Subtitle' && matches(codes, stream)
      && (stream.IsTextSubtitleStream || options.SkipSubtitlesIfEmbeddedSubtitlesPresent && !stream.IsExternal))) continue;
    if (options.SkipSubtitlesIfAudioTrackMatches && defaults.some(stream => matches(codes, stream))) continue;
    try {
      const [result] = await searchRemoteSubtitles(providers, item, {
        language, isAutomated: true, isPerfectMatch: options.RequirePerfectSubtitleMatch,
      }, options, { signal, onError });
      if (result) {
        await downloadSubtitle(subtitleDestinations(services), providers, item, result.Id, signal);
        downloaded = true;
      }
    } catch (error) { signal.throwIfAborted(); onError(error); }
  }
  if (downloaded) await services.metadata.refreshLiveItem(item, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true, signal });
}

async function downloadMissing(services, definition, { signal, reportProgress }, onError) {
  const providers = services.plugins.entries(definition.provider);
  if (!providers.length) { reportProgress(100); return; }
  const roots = await services.library.getPhysicalScanRoots({ signal });
  for (const [index, root] of roots.entries()) {
    const options = await itemLibraryOptions(services.library, root);
    const lyrics = definition.provider === 'lyric';
    const disabled = (lyrics ? options.DisabledLyricFetchers : options.DisabledSubtitleFetchers) ?? [];
    if (providers.every(provider => disabled.some(name => ordinalIgnoreCaseEquals(name, provider.name)))
      || !lyrics && !options.SubtitleDownloadLanguages?.length) continue;
    let after;
    for (;;) {
      signal.throwIfAborted();
      const rows = await services.store.run(db => db.rows('BaseItems', {
        columns: ['Id'], where: { MediaType: definition.mediaType, IsVirtualItem: false,
          TopParentId: nativeGuid(root.Id), PrimaryVersionId: null, ...(lyrics && { OwnerId: null }) },
        whereIn: { Type: definition.itemTypes, ChannelId: [null, '00000000-0000-0000-0000-000000000000'] }, after, limit: 100,
      }), { signal });
      if (!rows.length) break;
      for (const { Id } of rows) {
        signal.throwIfAborted();
        try {
          await services.library.withItemRecord(Id, {}, item => lyrics
            ? downloadLyrics(services, item, options, signal)
            : downloadSubtitles(services, item, options, providers, signal, onError));
        } catch (error) { signal.throwIfAborted(); onError(error); }
      }
      after = { Id: rows.at(-1).Id };
    }
    reportProgress(100 * (index + 1) / roots.length);
  }
  reportProgress(100);
}

export class DownloadMediaTaskWorker extends ScheduledTaskWorker {
  constructor({ key, services, onError = () => {}, ...options }) {
    const definition = tasks[key];
    super({ ...options, onError,
      definition: { key, id: md5Guid(definition.type), nameKey: definition.resource, name: definition.name,
        descriptionKey: definition.resource + 'Description', description: definition.description, categoryKey: 'TasksLibraryCategory',
        category: 'Library', defaultTriggers: [{ Type: 'IntervalTrigger', IntervalTicks: 864_000_000_000n }] },
      run: operation => services.runBackground(() => downloadMissing(services, definition, operation, onError)),
    });
  }
}
