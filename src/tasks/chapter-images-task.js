import { md5Guid } from '../core/identity.js';
import { dateTicks, mapRecord, VIDEO_TYPES } from '../library/records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeGuid } from '../users/native.js';
import { ScheduledTaskWorker } from './refresh-library-task.js';

export const chapterImagesTaskId = md5Guid('Emby.Server.Implementations.ScheduledTasks.Tasks.ChapterImagesTask');
const hourTicks = 36000000000n;
const emptyChannel = nativeGuid('00000000000000000000000000000000');

async function runChapterImages({ chapterImages, store, fileSystem, historyPath, onError }, { signal, reportProgress }) {
  const history = new Map();
  try {
    const value = await fileSystem.readFile(historyPath(), { signal });
    for (const entry of value.toString('utf8').split('|').filter(Boolean)) history.set(ordinalIgnoreCaseKey(entry), entry);
  } catch (error) { if (signal.aborted) throw error; }
  let after;
  while (true) {
    const rows = await store.run(database => database.rows('BaseItems', { where: { MediaType: 'Video', IsFolder: false, IsVirtualItem: false },
      whereIn: { ChannelId: [null, emptyChannel] }, limit: 128, after }), { signal });
    if (!rows.length) break;
    for (const row of rows) {
      signal.throwIfAborted();
      const video = mapRecord(row);
      if (!video || !VIDEO_TYPES.has(video.Type)) continue;
      const key = (video.Path ?? '') + dateTicks(video.DateModified);
      let success;
      try { success = await chapterImages.refresh(video, { extract: !history.has(ordinalIgnoreCaseKey(key)), signal }); }
      catch (error) {
        if (signal.aborted) throw error;
        if (!['not-found', 'unmapped-path', 'permission-denied', 'invalid-path'].includes(error.code)) throw error;
        onError?.(error); success = false;
      }
      if (!success) {
        history.set(ordinalIgnoreCaseKey(key), key);
        await fileSystem.writeFile(historyPath(), [...history.values()].join('|'), { signal });
      }
    }
    after = { Id: rows.at(-1).Id };
  }
  reportProgress(100);
}

export class ChapterImagesTaskWorker extends ScheduledTaskWorker {
  constructor({ chapterImages, store, fileSystem, historyPath, ...options }) {
    super({ ...options,
      definition: {
        id: chapterImagesTaskId, key: 'RefreshChapterImages', nameKey: 'TaskRefreshChapterImages', name: 'Extract Chapter Images',
        descriptionKey: 'TaskRefreshChapterImagesDescription', description: 'Creates thumbnails for videos that have chapters.',
        categoryKey: 'TasksLibraryCategory', category: 'Library',
        defaultTriggers: [{ Type: 'DailyTrigger', TimeOfDayTicks: 2n * hourTicks, MaxRuntimeTicks: 4n * hourTicks }],
      },
      run: operation => runChapterImages({ chapterImages, store, fileSystem, historyPath, onError: options.onError }, operation),
    });
  }
}
