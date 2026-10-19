import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { fillMissingEpisodeNumbersFromPath } from './episode-naming.js';

export async function beforeEpisodeMetadataRefresh(item, loaded, { replaceAllMetadata = false, probe, logger = { error() {} } } = {}) {
  if (item.IsLocked || !['Library', 'LiveTV', 0, 2, undefined, null].includes(item.SourceType)) return false;
  if (loaded.libraryOptions.EnableEmbeddedEpisodeInfos && ordinalIgnoreCaseEquals(item.Container, 'mp4')) {
    try {
      if (!probe) throw new Error('Embedded episode information requires a configured probe service.');
      // The native hook ignores the request token and does not persist media
      // streams, timestamps or technical fields while reading these tags.
      const info = await probe.readMediaInfo(loaded);
      if (info.ParentIndexNumber > 0) item.ParentIndexNumber = info.ParentIndexNumber;
      if (info.IndexNumber > 0) item.IndexNumber = info.IndexNumber;
      if (info.ShowName != null && info.ShowName !== '') item.SeriesName = info.ShowName;
    } catch (error) { logger.error(error, 'Error reading the episode information with ffprobe'); }
  }
  try { return fillMissingEpisodeNumbersFromPath(item, loaded, replaceAllMetadata); }
  catch (error) { logger.error(error, 'Error in FillMissingEpisodeNumbersFromPath'); return false; }
}
