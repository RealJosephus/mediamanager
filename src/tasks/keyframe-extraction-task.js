import { md5Guid } from '../core/identity.js';
import { quoteIdentifier } from '../database/model.js';
import { isNativeVideoFileName, movieNativeType } from '../library/video-file-resolver.js';
import { nativeGuid } from '../users/native.js';
import { ScheduledTaskWorker } from './refresh-library-task.js';

export const keyframeExtractionTaskId = md5Guid('Jellyfin.MediaEncoding.Hls.ScheduledTasks.KeyframeExtractionScheduledTask');
const itemTypes = [movieNativeType, 'MediaBrowser.Controller.Entities.TV.Episode'];
const emptyChannel = nativeGuid('00000000000000000000000000000000');
const pageSize = 1000;

async function runKeyframeExtraction(playback, { signal, reportProgress }) {
  const store = playback.library.store;
  const total = await store.run(async database => {
    const items = quoteIdentifier(database.schemaName) + '."BaseItems"';
    const result = await database.client.query(
      `SELECT count(*) AS total FROM ${items}
       WHERE "Type" = ANY($1::bytea[]) AND "MediaType" = $2 AND "IsVirtualItem" IS FALSE
          AND ("ChannelId" IS NULL OR "ChannelId" = $3)`,
      [itemTypes.map(type => Buffer.from(type)), Buffer.from('Video'), Buffer.from(emptyChannel)]);
    return Number(result.rows[0].total);
  }, { signal });
  let after, completed = 0;
  while (completed < total) {
    const rows = await store.run(database => database.rows('BaseItems', {
      columns: ['Id', 'Path'], where: { MediaType: 'Video', IsVirtualItem: false },
      whereIn: { Type: itemTypes, ChannelId: [null, emptyChannel] }, after, limit: pageSize,
    }), { signal });
    if (!rows.length) break;
    for (const item of rows) {
      signal.throwIfAborted();
      if (item.Path && !item.Path.includes('://') && isNativeVideoFileName(item.Path)) {
        try {
          const access = playback.accessPath(item);
          await playback.keyframes.get(item.Id, access, { signal, scheduled: true });
        } catch (error) {
          if (signal.aborted || !['invalid-path', 'not-found', 'permission-denied', 'not-directory'].includes(error.code)) throw error;
        }
      }
      reportProgress(100 * ++completed / total);
    }
    after = { Id: rows.at(-1).Id };
  }
  reportProgress(100);
}

export class KeyframeExtractionTaskWorker extends ScheduledTaskWorker {
  constructor({ playback, ...options }) {
    super({
      ...options,
      definition: {
        id: keyframeExtractionTaskId, key: 'KeyframeExtraction', nameKey: 'TaskKeyframeExtractor', name: 'Keyframe Extractor',
        descriptionKey: 'TaskKeyframeExtractorDescription',
        description: 'Extracts keyframes from video files to create more precise HLS playlists. This task may run for a long time.',
        categoryKey: 'TasksLibraryCategory', category: 'Library', defaultTriggers: [],
      },
      run: operation => runKeyframeExtraction(playback, operation),
    });
  }
}
