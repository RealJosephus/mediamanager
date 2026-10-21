import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { onMetadataChanged } from '../metadata/metadata-changed.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { normalizeProbeFileDate } from '../storage/probe-lifecycle.js';
import { nativeDate } from '../sessions/user-data.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { acquireNativeItemLinkOwner } from './native-item-entity.js';
import { guideChannelId, materializeGuideChannel } from './live-tv-guide-channel.js';
import { withGuideProgramBatch } from './live-tv-guide-store.js';
import { updateLiveItemRepository } from './live-item-repository.js';
import { EMPTY_ID, idKey, libraryError, MIN_DATE } from './records.js';

const time = value => new Date(value instanceof Date ? value.getTime() : value);
const offset = (value, milliseconds) => new Date(time(value).getTime() + milliseconds).toISOString();

/** Guide refresh keeps captured channels, program membership and stale-item
 * selection in SQL. Recording timer executors are outside this service. */
export class LiveTvGuideService {
  #lifetime = new AbortController();
  #work = new Set();
  #closing;

  constructor({ liveTv, services, recordingFolders, sources, library, store, itemCreation, itemDeletion,
    linkedChildren, loadContext, updates, metadataScanner, images, metadataAssets,
    now = () => new Date(), onError = () => {} } = {}) {
    if (typeof liveTv?.admitRead !== 'function' || typeof services !== 'function'
      || typeof recordingFolders?.reconcile !== 'function' || typeof sources?.scanForTunerDeviceChanges !== 'function'
      || typeof library?.getInternalLiveTvFolder !== 'function' || !store || !itemCreation || !itemDeletion
      || !linkedChildren || typeof loadContext !== 'function' || !updates
      || typeof metadataScanner?.refreshLiveItem !== 'function' || typeof images?.preCache !== 'function'
      || typeof metadataAssets?.stat !== 'function') {
      throw new TypeError('Guide refresh requires live providers, SQL ownership, mapped images and repository lifecycles.');
    }
    Object.assign(this, { liveTv, services, recordingFolders, sources, library, store, itemCreation, itemDeletion,
      linkedChildren, loadContext, updates, metadataScanner, images, metadataAssets, now, onError });
  }

  #report(cause) { try { void Promise.resolve(this.onError(cause)).catch(() => {}); } catch { /* Logging cannot change the refresh boundary. */ } }

  refresh({ signal, reportProgress } = {}) {
    if (typeof reportProgress !== 'function') return Promise.reject(new TypeError('Guide refresh requires progress reporting.'));
    if (this.#lifetime.signal.aborted) return Promise.reject(libraryError(503, 'Guide refresh is closing.'));
    const access = this.liveTv.admitRead();
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const pending = Promise.resolve().then(() => this.#refresh(access, combined, reportProgress)).finally(() => access.release());
    this.#work.add(pending);
    const finished = () => this.#work.delete(pending); pending.then(finished, finished);
    return pending;
  }

  async #fileInfo(identity) {
    try {
      const file = await this.metadataAssets.stat(identity);
      return { FullName: file.Path ?? identity, DateModified: file.modified ? nativeDate(normalizeProbeFileDate(file.modified)) : MIN_DATE };
    } catch (cause) {
      if (!['not-found', 'ENOENT', 'ENOTDIR'].includes(cause.code)) throw cause;
      return { FullName: identity, DateModified: MIN_DATE };
    }
  }

  async #channel(info, serviceName, parent, signal) {
    const existing = await this.itemCreation.getItemById(guideChannelId(serviceName, info.Id));
    const result = await materializeGuideChannel(info, { existing, serviceName, parent, now: this.now,
      getImageFileInfo: identity => this.#fileInfo(identity) });
    if (result.isNew) await this.itemCreation.createItems([result.item], parent, { creationIntent: 'library-save' });
    else if (result.isUpdated) await this.#updateChannel(result.item, signal);
    return result.item;
  }

  #updateChannel(item, signal) {
    const images = item.ImageInfos.map(image => ({ ...image,
      Blurhash: image.BlurHash == null ? null : Buffer.from(image.BlurHash, 'utf8') }));
    return updateLiveItemRepository(item, { ...this, updateReason: ItemUpdateType.MetadataImport, signal, includeChildren: false, images });
  }

  async #channelPrograms(service, channel, signal, seen, session, days, maxCacheDate) {
    const start = offset(this.now(), -3600000), end = offset(start, days * 86400000);
    const programs = await service.getPrograms(channel.ExternalId, start, end, { signal });
    const loaded = await this.loadContext(channel.Id, { draft: channel });
    try {
      await withGuideProgramBatch({ ...this, channel, metadataChanged: item => onMetadataChanged(item, loaded.parentalRating(item)), now: this.now }, async batch => {
        try {
          for (const info of programs) await batch.consume(info);
          batch.seal();
          await batch.saveNew({ signal });
          if (batch.counts.new) {
            const view = batch.newView;
            try { await this.images.preCache(view, maxCacheDate); } finally { await view.release(); }
          }
          await batch.saveUpdated({ signal });
          if (batch.counts.updated) {
            const view = batch.updatedView;
            try { await this.images.preCache(view, maxCacheDate); } finally { await view.release(); }
          }
          const flags = batch.flags;
          for (const [field, flag] of [['IsMovie', 'isMovie'], ['IsNews', 'isNews'], ['IsSports', 'isSports'], ['IsSeries', 'isSeries']]) channel[field] = flags[flag];
          if (flags.isKids && !channel.Tags.some(value => ordinalIgnoreCaseEquals(value, 'Kids'))) channel.Tags = [...channel.Tags, 'Kids'];
          await this.#updateChannel(channel, signal);
          await this.metadataScanner.refreshLiveItem(channel, { ForceSave: true, signal });
        } finally {
          const plan = batch.seenPlan;
          await session.client.query(`INSERT INTO ${seen}("Key") SELECT DISTINCT ${nativeTextSql(session.schemaName).guidKey('source."Id"')}
            FROM (${plan.text}) source ON CONFLICT DO NOTHING`, plan.values);
        }
      });
    } finally { await loaded.dispose(); }
  }

  async #service(service, access, signal, progress, seenChannels, seenPrograms, session) {
    progress(10);
    const incoming = await service.getChannels({ enableCache: false, signal });
    const parent = await this.library.getInternalLiveTvFolder(), parentOwner = acquireNativeItemLinkOwner(parent);
    let channels, errors = false, ordinal = 0n;
    try {
      channels = await createNativeItemCohort({ linkedChildren: this.linkedChildren,
        resolveLiveItem: id => this.itemCreation.getCachedItemById(id) });
      for (const [index, info] of incoming.entries()) {
        signal.throwIfAborted();
        try { await channels.capture(await this.#channel(info, service.name, parent, signal), { ordinal: ++ordinal }); }
        catch (cause) { signal.throwIfAborted(); errors = true; this.#report(cause); }
        progress(10 + 5 * ((index + 1) / incoming.length));
      }
      progress(15);
      // Native GetGuideDays is evaluated even when every channel failed.
      const configuration = await access.getConfiguration();
      const guideDays = configuration.GuideDays == null ? 7 : Math.max(1, Math.min(14, configuration.GuideDays));
      const maxCacheDate = offset(this.now(), 2 * 86400000);
      let completed = 0;
      for (let after = 0n; ;) {
        const page = await channels.page({ after, limit: 128 });
        try {
          if (!page.entries.length) break;
          for (const entry of page.entries) {
            signal.throwIfAborted();
            await session.client.query(`INSERT INTO ${seenChannels} VALUES($1) ON CONFLICT DO NOTHING`, [idKey(entry.item.Id)]);
            try { await this.#channelPrograms(service, entry.item, signal, seenPrograms, session, guideDays, maxCacheDate); }
            catch (cause) { signal.throwIfAborted(); errors = true; this.#report(cause); }
            progress(15 + 85 * (++completed / incoming.length));
          }
          after = page.entries.at(-1).Ordinal;
        } finally { await page.release(); }
      }
      progress(100); return errors;
    } finally {
      try { await channels?.release(); } finally { parentOwner.release(); await this.linkedChildren.flushReleases(); }
    }
  }

  async #clean(type, seen, signal, progress, session) {
    const table = q('mm_guide_clean_' + randomUUID().replaceAll('-', ''));
    const plan = buildPostgresItemPageQuery(session, { includeitemtypes: [type] }, { includeOrdinal: true });
    const key = nativeTextSql(session.schemaName).guidKey;
    try {
      await session.client.query(`CREATE TEMP TABLE ${table} AS SELECT source."__ordinal" AS "Ordinal",source."Id",
        EXISTS(SELECT 1 FROM ${seen} seen WHERE seen."Key"=${key('source."Id"')}) AS "Retained" FROM (${plan.text}) source
        WHERE source."Id" IS NOT NULL`, plan.values);
      const total = BigInt((await session.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
      let completed = 0n;
      for (let after = 0n; ;) {
        const rows = (await session.client.query(`/* guide-clean-page */ SELECT * FROM ${table} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
        if (!rows.length) break;
        for (const row of rows) {
          signal.throwIfAborted();
          const id = decodeNativeTextBytes(row.Id, 'runtime');
          if (idKey(id) === idKey(EMPTY_ID)) continue;
          if (!row.Retained) await this.itemCreation.withItem(id, item => item && this.itemDeletion.deleteItem(item,
            { DeleteFileLocation: false, DeleteFromExternalProvider: false }, undefined, false));
          progress(100 * Number(++completed) / Number(total));
        }
        after = BigInt(rows.at(-1).Ordinal);
      }
    } finally {
      try { await session.client.query(`DROP TABLE IF EXISTS ${table}`); }
      catch (cause) { session.discardConnection(cause); throw cause; }
    }
  }

  async #refresh(access, signal, progress) {
    await this.recordingFolders.reconcile();
    await this.sources.scanForTunerDeviceChanges({ signal });
    const services = this.services();
    return this.store.run(async session => {
      if (session.inTransaction) throw new TypeError('Guide refresh must own an autocommit SQL session.');
      const suffix = randomUUID().replaceAll('-', ''), seenChannels = q('mm_guide_channels_' + suffix), seenPrograms = q('mm_guide_programs_' + suffix);
      try {
        await session.client.query(`CREATE TEMP TABLE ${seenChannels}("Key" text PRIMARY KEY);CREATE TEMP TABLE ${seenPrograms}("Key" text PRIMARY KEY)`);
        let clean = true;
        for (const [index, service] of services.entries()) {
          signal.throwIfAborted();
          try { clean = !(await this.#service(service, access, signal, value => progress(value / services.length), seenChannels, seenPrograms, session)) && clean; }
          catch (cause) { signal.throwIfAborted(); clean = false; this.#report(cause); }
          progress(100 * ((index + 1) / services.length));
        }
        if (clean) {
          await this.#clean('LiveTvChannel', seenChannels, signal, progress, session);
          await this.#clean('LiveTvProgram', seenPrograms, signal, progress, session);
        }
        progress(100);
      } finally {
        try { await session.client.query(`DROP TABLE IF EXISTS ${seenChannels};DROP TABLE IF EXISTS ${seenPrograms}`); }
        catch (cause) { session.discardConnection(cause); throw cause; }
      }
    });
  }

  close() {
    this.#lifetime.abort();
    return this.#closing ??= (async () => { while (this.#work.size) await Promise.allSettled([...this.#work]); })();
  }
}
