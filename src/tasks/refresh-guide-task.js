import { ScheduledTaskWorker } from './refresh-library-task.js';

export const refreshGuideTaskId = 'bea9b218c97bbf98c5dc1303bdb9a0ca';
export const refreshGuideTaskKey = 'RefreshGuide';
export const defaultRefreshGuideTaskTriggers = Object.freeze([
  Object.freeze({ Type: 'IntervalTrigger', IntervalTicks: 864000000000n }),
]);

/** The native Guide task delegates execution and observes live configuration. */
export class RefreshGuideTaskWorker extends ScheduledTaskWorker {
  constructor({ getGuideServiceCount, getGuideConfiguration, refreshGuide, ...options } = {}) {
    if (typeof getGuideServiceCount !== 'function' || typeof getGuideConfiguration !== 'function' || typeof refreshGuide !== 'function') {
      throw new TypeError('Refresh Guide requires service, configuration and refresh operations.');
    }
    super({ ...options, definition: {
      id: refreshGuideTaskId, key: refreshGuideTaskKey, name: 'Refresh Guide',
      description: 'Downloads channel information from live tv services.', category: 'Live TV',
      configurable: true, defaultTriggers: defaultRefreshGuideTaskTriggers,
    }, run: refreshGuide });
    Object.assign(this, { getGuideServiceCount, getGuideConfiguration });
  }

  async isHidden() {
    return this.getGuideServiceCount() === 1 && (await this.getGuideConfiguration()).TunerHosts.length === 0;
  }
}
