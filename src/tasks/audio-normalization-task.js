import { md5Guid } from '../core/identity.js';
import { withCleanup } from '../core/operation-failure.js';
import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { idKey } from '../library/records.js';
import { measureLoudness, loudnessTimeoutMs } from '../media-execution/loudness.js';
import { ScheduledTaskWorker } from './refresh-library-task.js';

export const audioNormalizationTaskId = md5Guid('Emby.Server.Implementations.ScheduledTasks.Tasks.AudioNormalizationTask');
const hourTicks = 36000000000n;
const audioType = 'MediaBrowser.Controller.Entities.Audio.Audio';
const albumType = 'MediaBrowser.Controller.Entities.Audio.MusicAlbum';
const collectionType = 'MediaBrowser.Controller.Entities.CollectionFolder';
const columns = ['Id', 'Path', 'DateModified'];
const isLocal = track => typeof track.Path === 'string' && track.Path !== '' && !track.Path.includes('://');

async function candidateRows(database, condition, parameters, after) {
  const result = await database.client.query(
    `SELECT item."Id", item."Path", item."DateModified" FROM "BaseItems" item
     WHERE ${condition} AND ($${parameters.length + 1}::bytea IS NULL OR item."Id" > $${parameters.length + 1})
     ORDER BY item."Id" LIMIT 128`, [...parameters, after]);
  return result.rows.map(row => Object.fromEntries(columns.map(column => [column,
    row[column] == null ? null : decodeNativeTextBytes(row[column])])));
}

async function* candidates(store, condition, parameters, signal) {
  let after = null;
  while (true) {
    const rows = await store.run(database => candidateRows(database, condition, parameters, after), { signal });
    if (!rows.length) return;
    for (const row of rows) yield row;
    after = nativeTextBytes(rows.at(-1).Id);
  }
}

async function albumTracks(store, album, signal) {
  const tracks = [];
  for await (const row of candidates(store, `item."Type" = $1 AND (item."ParentId" = $2 OR EXISTS (
      SELECT 1 FROM "AncestorIds" ancestor WHERE ancestor."ItemId" = item."Id" AND ancestor."ParentItemId" = $2))`,
  [nativeTextBytes(audioType), nativeTextBytes(album.Id)], signal)) {
    if (isLocal(row)) tracks.push(row);
  }
  return tracks;
}

async function analyzeTracks(playback, probe, tracks, album, signal) {
  const leases = [];
  return withCleanup(async () => {
    for (const item of tracks) {
      leases.push(await probe.bridge.lease(playback.accessPath(item), { signal, expiresInMs: loudnessTimeoutMs + 60000 }));
    }
    return measureLoudness(probe.mediaEncoder, leases.map(lease => lease.url), { album, signal });
  }, [async () => {
    const settled = await Promise.allSettled(leases.map(lease => lease.release()));
    const failures = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Loudness input leases failed to release.');
  }], 'Loudness analysis and input cleanup failed.');
}

async function runAudioNormalization(playback, probe, onError, { signal, reportProgress }) {
  const { library } = playback;
  const { store } = library;
  const options = library.options.libraryOptions;
  const libraries = await store.run(async database => {
    const collections = await database.rows('BaseItems', { where: { Type: collectionType }, columns: ['Id'] });
    return collections.filter(item => (options instanceof Map ? options.get(idKey(item.Id)) : options?.[idKey(item.Id)])?.EnableLUFSScan);
  }, { signal });
  let completed = 0;
  for (const libraryItem of libraries) {
    const physical = await library.getPhysicalScanRoots({ collectionId: libraryItem.Id, signal });
    const roots = physical.map(root => nativeTextBytes(root.Id));
    const membership = roots.length ? 'item."TopParentId" = ANY($2::bytea[])'
      : `EXISTS (SELECT 1 FROM "AncestorIds" ancestor WHERE ancestor."ItemId" = item."Id" AND ancestor."ParentItemId" = $2)`;
    const parent = roots.length ? roots : nativeTextBytes(libraryItem.Id);
    const pending = [];
    let nextSave = Date.now() + 300000;
    const save = async () => {
      if (pending.length < 2) return;
      await store.transaction(async database => {
        for (const { item, lufs } of pending) {
          if (lufs == null) continue;
          await database.updateWhere('BaseItems', { Id: item.Id, Path: item.Path, DateModified: item.DateModified,
            LUFS: null, NormalizationGain: null }, { LUFS: lufs });
        }
      }, { signal });
      pending.length = 0;
    };
    for (const [type, album] of [[albumType, true], [audioType, false]]) {
      const filter = `item."Type" = $1 AND ${membership} AND item."LUFS" IS NULL AND item."NormalizationGain" IS NULL`
        + (album ? '' : ' AND item."MediaType" = $3');
      const parameters = [nativeTextBytes(type), parent, ...(album ? [] : [nativeTextBytes('Audio')])];
      const total = Number(await store.run(async database => {
        const { rows } = await database.client.query(`SELECT count(*) AS total FROM "BaseItems" item WHERE ${filter}`, parameters);
        return rows[0].total;
      }, { signal }));
      let scanned = 0;
      for await (const item of candidates(store, filter, parameters, signal)) {
        signal.throwIfAborted();
        const tracks = album ? await albumTracks(store, item, signal) : isLocal(item) ? [item] : [];
        if (tracks.length >= (album ? 2 : 1)) {
          let lufs = null;
          try { lufs = await analyzeTracks(playback, probe, tracks, album, signal); }
          catch (error) {
            if (signal.aborted || !['not-found', 'invalid-path', 'permission-denied', 'version-changed'].includes(error.code)) throw error;
            await onError?.(error);
          }
          pending.push({ item, lufs });
        }
        if (Date.now() > nextSave) { await save(); nextSave = Date.now() + 300000; }
        reportProgress(100 * (completed + (album ? 0 : 0.5) + Math.min(1, ++scanned / total) / 2) / libraries.length);
      }
      // Native carries a single pending album into its track phase and only
      // saves a phase batch when it has more than one item.
      await save();
      nextSave = Date.now() + 300000;
    }
    reportProgress(100 * ++completed / libraries.length);
  }
  reportProgress(100);
}

export class AudioNormalizationTaskWorker extends ScheduledTaskWorker {
  constructor({ playback, probe, ...options }) {
    super({ ...options,
      definition: {
        id: audioNormalizationTaskId, key: 'AudioNormalization', nameKey: 'TaskAudioNormalization', name: 'Audio Normalization',
        descriptionKey: 'TaskAudioNormalizationDescription', description: 'Analyzes audio items for loudness normalization.',
        categoryKey: 'TasksLibraryCategory', category: 'Library',
        defaultTriggers: [{ Type: 'IntervalTrigger', IntervalTicks: 24n * hourTicks }],
      },
      run: operation => runAudioNormalization(playback, probe, options.onError, operation),
    });
  }
}
