import { VIDEO_TYPES } from './records.js';

/** Run intro providers concurrently while retaining their declared result order. */
export class IntroProviderManager {
  #controller = new AbortController();
  constructor({ extensions = () => [], getItem, resolvePath, logger = console } = {}) {
    Object.assign(this, { extensions, getItem, resolvePath, logger });
  }

  async getIntros(item, user) {
    const batches = await Promise.all(this.extensions().map(async provider => {
      try { return await provider.getIntros(item, { user, signal: this.#controller.signal }); }
      catch (error) { this.logger.error?.(error, 'Error getting intros'); return []; }
    }));
    const result = [];
    for (const batch of batches) for (const info of batch) {
      const intro = await this.#resolve(info);
      if (intro) result.push(intro);
    }
    return result;
  }

  close() { this.#controller.abort(); }

  async #resolve(info) {
    let video = null;
    if (info.ItemId != null) {
      const item = await this.getItem(info.ItemId);
      video = VIDEO_TYPES.has(item?.Type) ? item : null;
      if (!video) this.logger.error?.(`Unable to locate item with Id ${info.ItemId}.`);
    } else if (info.Path) {
      try {
        const resolved = await this.resolvePath(info.Path);
        video = VIDEO_TYPES.has(resolved?.Type) ? resolved : null;
        if (!video) this.logger.error?.(`Intro resolver returned null for ${info.Path}.`);
        else {
          const saved = await this.getItem(video.Id);
          if (!VIDEO_TYPES.has(saved?.Type)) return null;
          video = saved;
        }
      } catch (error) { this.logger.error?.(error, `Error resolving path ${info.Path}.`); }
    } else this.logger.error?.('IntroProvider returned an IntroInfo with null Path and ItemId.');
    return video;
  }
}
