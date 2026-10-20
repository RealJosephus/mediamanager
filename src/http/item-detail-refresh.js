import { dateTicks } from '../library/records.js';
import { clrTrim } from '../metadata/whitespace.js';
import { httpError } from './binding.js';

const threeDays = 3n * 24n * 60n * 60n * 10000000n;

export async function refreshItemDetail(item, { metadata, signal, clock = () => new Date(), onError = () => {} } = {}) {
  if (item.Type !== 'Person') return;
  const hasMetadata = clrTrim(item.Overview ?? '').length > 0
    && item.ImageInfos?.some(image => image.Type === 'Primary' || image.Type === 0);
  if (hasMetadata || dateTicks(clock().toISOString()) - dateTicks(item.DateLastRefreshed) < threeDays) return;
  if (!metadata) throw httpError(501, 'Metadata refresh requires configured storage.');

  const options = { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'FullRefresh', ForceSave: true };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 3000);
  const linked = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    await metadata.refresh(item.Id, { ...options, signal: linked });
  } catch (error) {
    if (signal?.aborted || error?.name !== 'AbortError') throw error;
    // The queued retry owns its lifetime; the request's timeout must not follow it.
    const pending = metadata.queue(item.Id, options, 0);
    void Promise.resolve(pending).catch(error => {
      try { void Promise.resolve(onError(error)).catch(() => {}); }
      catch { /* A background reporter cannot change the completed request. */ }
    });
  } finally {
    clearTimeout(timer);
  }
}
