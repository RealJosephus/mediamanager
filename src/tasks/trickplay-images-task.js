import { md5Guid } from '../core/identity.js';
import { mapRecord, VIDEO_TYPES } from '../library/records.js';
import { nativeGuid } from '../users/native.js';
import { ScheduledTaskWorker } from './refresh-library-task.js';

export const trickplayImagesTaskId = md5Guid('MediaBrowser.Providers.Trickplay.TrickplayImagesTask');
export const trickplayMoveImagesTaskId = md5Guid('MediaBrowser.Providers.Trickplay.TrickplayMoveImagesTask');
const emptyChannel = nativeGuid('00000000000000000000000000000000');

async function generateAll(trickplay, store, onError, { signal, reportProgress }) {
  let after;
  while (true) {
    const rows = await store.run(database => database.rows('BaseItems', { where: { MediaType: 'Video', IsFolder: false, IsVirtualItem: false },
      whereIn: { ChannelId: [null, emptyChannel] }, after, limit: 1000 }), { signal });
    if (!rows.length) break;
    for (const row of rows) {
      signal.throwIfAborted();
      const video = mapRecord(row);
      if (!video || !VIDEO_TYPES.has(video.Type)) continue;
      try { await trickplay.refresh(video, { signal }); }
      catch (error) { if (signal.aborted) throw error; onError?.(error); }
    }
    after = { Id: rows.at(-1).Id };
  }
  reportProgress(100);
}

export class TrickplayImagesTaskWorker extends ScheduledTaskWorker {
  constructor({ trickplay, store, ...options }) {
    super({ ...options,
      definition: {
        id: trickplayImagesTaskId, key: 'RefreshTrickplayImages', nameKey: 'TaskRefreshTrickplayImages', name: 'Generate Trickplay Images',
        descriptionKey: 'TaskRefreshTrickplayImagesDescription', description: 'Creates timeline previews for videos in the library.',
        categoryKey: 'TasksLibraryCategory', category: 'Library',
        defaultTriggers: [{ Type: 'DailyTrigger', TimeOfDayTicks: 108000000000n }],
      },
      run: operation => generateAll(trickplay, store, options.onError, operation),
    });
  }
}

async function moveAll(trickplay, store, onError, { signal, reportProgress }) {
  let after;
  while (true) {
    const { layouts, videos } = await store.run(async database => {
      const layouts = await database.rows('TrickplayInfos', { after, limit: 100 });
      const ids = [...new Set(layouts.map(value => value.ItemId))];
      const videos = ids.length ? await database.rows('BaseItems', { where: { MediaType: 'Video', IsVirtualItem: false, IsFolder: false },
        whereIn: { Id: ids, ChannelId: [null, emptyChannel] } }) : [];
      return { layouts, videos };
    }, { signal });
    if (!layouts.length) break;
    for (const data of videos) {
      signal.throwIfAborted();
      const item = mapRecord(data);
      if (!item) continue;
      try { await trickplay.move(item, { signal }); }
      catch (error) { if (signal.aborted) throw error; onError?.(error); }
    }
    const { ItemId, Width } = layouts.at(-1);
    after = { ItemId, Width };
  }
  reportProgress(100);
}

export class TrickplayMoveImagesTaskWorker extends ScheduledTaskWorker {
  constructor({ trickplay, store, ...options }) {
    super({ ...options,
      definition: {
        id: trickplayMoveImagesTaskId, key: 'MoveTrickplayImages', nameKey: 'TaskMoveTrickplayImages', name: 'Migrate Trickplay Image Location',
        descriptionKey: 'TaskMoveTrickplayImagesDescription', description: 'Moves existing trickplay files according to the library settings.',
        categoryKey: 'TasksMaintenanceCategory', category: 'Maintenance', defaultTriggers: [],
      },
      run: operation => moveAll(trickplay, store, options.onError, operation),
    });
  }
}
