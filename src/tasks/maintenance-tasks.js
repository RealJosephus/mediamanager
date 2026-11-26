import * as fs from 'node:fs/promises';
import path from 'node:path';
import { md5Guid } from '../core/identity.js';
import { ScheduledTaskWorker } from './refresh-library-task.js';

const dayMilliseconds = 86_400_000;
const maintenance = { categoryKey: 'TasksMaintenanceCategory', category: 'Maintenance', configurable: true };

export class CleanActivityLogTaskWorker extends ScheduledTaskWorker {
  constructor({ activities, getConfiguration, clock = () => new Date(), ...options }) {
    super({ ...options, clock,
      definition: { ...maintenance,
        id: md5Guid('Emby.Server.Implementations.ScheduledTasks.Tasks.CleanActivityLogTask'), key: 'CleanActivityLog',
        nameKey: 'TaskCleanActivityLog', name: 'Clean Activity Log',
        descriptionKey: 'TaskCleanActivityLogDescription', description: 'Deletes activity log entries older than the configured age.',
        defaultTriggers: [],
      },
      run: () => {
        const { ActivityLogRetentionDays: days } = getConfiguration();
        if (days == null || days < 0) throw new Error(`Activity Log Retention days must be at least 0. Currently: ${days ?? ''}`);
        return activities.cleanThrough(new Date(clock().valueOf() - days * dayMilliseconds));
      },
    });
  }
}

async function missingAsUndefined(operation) {
  try { return await operation(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function cleanDirectory(fileSystem, root, cutoff, { exclude = [], signal, reportProgress, onError }) {
  if (!root || !(await missingAsUndefined(() => fileSystem.lstat(root)))?.isDirectory()) return;
  const files = [], subdirectories = [];
  const expired = async filename => {
    if (fileSystem.vfs) {
      const info = await fileSystem.vfs.stat(fileSystem.accessPath(filename), { signal }).catch(error => {
        if (error.code !== 'not-found') throw error;
      });
      return info?.kind === 'file' && Date.parse(info.modified) < cutoff;
    }
    const info = await missingAsUndefined(() => fileSystem.lstat(filename));
    return info?.isFile() && info.mtimeMs < cutoff;
  };
  const collect = async directory => {
    const entries = await missingAsUndefined(() => fileSystem.readdir(directory, { withFileTypes: true, regularEntriesOnly: true, signal }));
    for (const entry of entries ?? []) {
      signal.throwIfAborted();
      const filename = path.join(directory, entry.name);
      if (exclude.some(root => path.relative(filename, root) === '')) continue;
      if (entry.isDirectory()) {
        if (!(await missingAsUndefined(() => fileSystem.lstat(filename)))?.isDirectory()) continue;
        await collect(filename);
        subdirectories.push(filename);
      } else if (entry.isFile() && await expired(filename)) files.push(filename);
    }
  };
  await collect(root);
  for (const [index, filename] of files.entries()) {
    reportProgress(100 * index / files.length);
    signal.throwIfAborted();
    try {
      if (await expired(filename)) await fileSystem.unlink(filename);
    } catch (error) { if (error.code !== 'ENOENT') await onError?.(error); }
  }
  for (const directory of subdirectories) {
    signal.throwIfAborted();
    try { await fileSystem.rmdir(directory); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) await onError?.(error); }
  }
  reportProgress(100);
}

function withinDirectory(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export class DeleteCacheFilesTaskWorker extends ScheduledTaskWorker {
  constructor({ applicationPaths, fileSystem, withStorageGeneration, clock = () => new Date(), ...options }) {
    super({ ...options, clock,
      definition: { ...maintenance,
        id: md5Guid('Emby.Server.Implementations.ScheduledTasks.Tasks.DeleteCacheFileTask'), key: 'DeleteCacheFiles',
        nameKey: 'TaskCleanCache', name: 'Clean Cache Directory',
        descriptionKey: 'TaskCleanCacheDescription', description: 'Deletes cache files no longer needed by the system.',
        defaultTriggers: [{ Type: 'IntervalTrigger', IntervalTicks: 864_000_000_000n }],
      },
      run: async operation => {
        const { cachePath, tempPath } = applicationPaths;
        const now = clock().valueOf(), cleanup = { ...operation, onError: options.onError };
        if (cachePath && !(tempPath && withinDirectory(tempPath, cachePath))) await withStorageGeneration(async () => {
          // A metadata prefix can have no directory entry on its parent's backend.
          const roots = new Set([cachePath]);
          for (const { identityRoot, style } of fileSystem.identityMap.exportState().prefixes) {
            if (style === (process.platform === 'win32' ? 'windows' : 'posix') && withinDirectory(cachePath, identityRoot)
              && !(tempPath && withinDirectory(tempPath, identityRoot))) roots.add(identityRoot);
          }
          const exclude = [...roots, tempPath].filter(Boolean);
          for (const root of roots) await cleanDirectory(fileSystem, root, now - 30 * dayMilliseconds, { ...cleanup, exclude });
        });
        operation.reportProgress(90);
        await cleanDirectory(fs, tempPath, now - dayMilliseconds, cleanup);
      },
    });
  }
}
