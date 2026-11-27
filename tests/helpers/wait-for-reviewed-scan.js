import { on } from 'node:events';
import { refreshLibraryTaskId } from '../../src/tasks/index.js';

export async function waitForLibraryScan(tasks, options) {
  for await (const event of on(tasks, 'completed', options)) {
    if (event[0].Result?.Id === refreshLibraryTaskId) return event;
  }
}
