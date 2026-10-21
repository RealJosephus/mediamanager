import { availableParallelism } from 'node:os';
import { dateTicks, libraryError } from './records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { publishNativeImageInfos } from '../metadata/images.js';
import { nativeTextSql } from '../database/native-text-sql.js';

const failure = message => Object.assign(new Error(message), { nativeException: 'InvalidOperationException', status: 500 });
const nullReference = () => Object.assign(new TypeError('Object reference not set to an instance of an object.'), { nativeException: 'NullReferenceException', status: 500 });
function imagePath(image) { if (typeof image?.Path !== 'string') throw nullReference(); return ordinalIgnoreCaseKey(image.Path); }
const local = image => !imagePath(image).startsWith('HTTP');
const sd = image => imagePath(image).includes('SCHEDULESDIRECT');
function allLocalOrSd(item) {
  if (!Array.isArray(item.ImageInfos)) throw nullReference();
  return item.ImageInfos.every(image => local(image) || sd(image));
}
const imageRows = item => item.ImageInfos.map(image => ({ ...image, Blurhash: image.BlurHash == null ? null : Buffer.from(image.BlurHash, 'utf8') }));
function restoreReferences(item, originals) {
  const values = item.ImageInfos;
  // SaveImage/RunMetadataSavers mutate existing ItemImageInfo references. The
  // metadata row bridge publishes plain values, so restore the original refs.
  item.ImageInfos = values.map((value, index) => {
    const original = originals[index];
    if (!original) return value;
    Object.assign(original, value); return original;
  });
}

/** GuideManager.PreCacheImages and LibraryManager.ConvertImageToLocal. The
 * caller owns shared images/updates/storage; close drains this consumer first. */
export class LiveTvGuideImages {
  #closed = false;
  #closing;
  #work = new Set();
  #lifetime = new AbortController();
  constructor({ store, linkedChildren, loadContext, itemCreation, updates, images, isImageDailyLimitActive,
    runWorker, onError = () => {}, parallelism = Math.min(availableParallelism(), 10) }) {
    if (typeof store?.run !== 'function' || !linkedChildren || typeof loadContext !== 'function'
      || typeof itemCreation?.registerItem !== 'function' || typeof updates?.update !== 'function'
      || typeof images?.saveRemote !== 'function' || typeof isImageDailyLimitActive !== 'function'
      || typeof runWorker !== 'function' || typeof onError !== 'function' || !Number.isInteger(parallelism) || parallelism < 1 || parallelism > 10) {
      throw new TypeError('Guide image caching requires SQL cohorts, actual image and repository services, and owned workers.');
    }
    Object.assign(this, { store, linkedChildren, loadContext, itemCreation, updates, images, isImageDailyLimitActive, runWorker, onError, parallelism });
  }

  preCache(view, maxCacheDate) {
    if (this.#closed) return Promise.reject(libraryError(503, 'Guide image caching has closed.'));
    if (typeof view?.guideImagePlan !== 'function' || typeof view?.withSlot !== 'function') return Promise.reject(new TypeError('An owned native program cohort is required.'));
    const cutoff = dateTicks(maxCacheDate), retained = view.retain();
    // Publish admission before invoking a potentially reentrant limit callback.
    const pending = Promise.resolve().then(() => this.#preCache(retained, cutoff));
    this.#work.add(pending);
    const finish = () => this.#work.delete(pending); pending.then(finish, finish);
    return pending;
  }

  async #preCache(view, cutoff) {
    let selected, primary;
    const stopped = new AbortController(), active = new Set(); let workerFailure;
    const signal = AbortSignal.any([this.#lifetime.signal, stopped.signal]);
    try {
      const limited = this.isImageDailyLimitActive();
      await view.flush();
      selected = await this.store.run(async session => {
        if (session.inTransaction) throw new TypeError('Guide image selection requires a nontransaction session.');
        const source = view.guideImagePlan(), offset = source.values.length;
        const text = nativeTextSql(session.schemaName), id = `lower(replace(${text.projection('candidate."Id"')},'-',''))`;
        return view.view({ session, plan: { text: `WITH candidates AS (SELECT * FROM (${source.text}) programs
            WHERE "EndDateTicks"<$${offset + 1} AND (NOT $${offset + 2} OR "AllImagesLocalOrSd" IS DISTINCT FROM TRUE)),
          ranked AS (SELECT candidate.*,row_number() OVER(PARTITION BY ${id} ORDER BY "Ordinal") AS identity_ordinal FROM candidates candidate)
          SELECT "Ordinal","SlotKey" FROM ranked WHERE identity_ordinal=1 OR ($${offset + 2} AND "AllImagesLocalOrSd" IS NULL) ORDER BY "Ordinal"`,
          values: [...source.values, cutoff, limited] } });
      });
      // SQL owns filtering and identity winners. Only bounded slot keys, then
      // one live entity per worker, cross into Node.
      for (let after = 0n; !signal.aborted;) {
        const plan = selected.orderedPlan();
        const rows = await this.store.run(async db => (await db.client.query({ text: `SELECT "Ordinal","SlotKey" FROM (${plan.text}) selection
          WHERE "Ordinal">$2 ORDER BY "Ordinal" LIMIT $3 /* guide-image-slot-page */`, values: [...plan.values, after, Math.min(this.parallelism, 128)] })).rows);
        if (!rows.length) break;
        for (const row of rows) {
          if (signal.aborted) break;
          while (active.size >= this.parallelism) await Promise.race(active);
          if (signal.aborted) break;
          after = BigInt(row.Ordinal);
          // The initial predicate is outside the worker body in native LINQ.
          if (limited) await selected.withSlot(row.SlotKey, item => { allLocalOrSd(item); });
          const task = Promise.resolve().then(() => this.runWorker(() => selected.withSlot(row.SlotKey, item => this.#program(item, signal))))
            .catch(error => { workerFailure ??= error; stopped.abort(error); });
          active.add(task); task.finally(() => active.delete(task)).catch(() => {});
        }
      }
      await Promise.all(active);
      if (workerFailure) throw workerFailure;
    } catch (error) { primary = error; stopped.abort(error); await Promise.allSettled(active); throw error; }
    finally {
      const errors = [];
      for (const release of [() => selected?.release(), () => view.release()]) try { await release(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors, primary?.message ?? 'Guide image cohort release failed.', primary ? { cause: primary } : undefined);
    }
  }

  async #program(item, signal) {
    if (this.isImageDailyLimitActive() && allLocalOrSd(item)) return;
    if (!Array.isArray(item.ImageInfos)) throw nullReference();
    for (let index = 0; index < item.ImageInfos.length; index++) {
      if (signal.aborted) return;
      const image = item.ImageInfos[index];
      if (local(image) || sd(image) && this.isImageDailyLimitActive()) continue;
      try { item.ImageInfos[index] = await this.#convert(item, image); }
      catch (error) { try { void Promise.resolve(this.onError(error, image.Path, item)).catch(() => {}); } catch { /* Logging does not change per-image continuation. */ } }
    }
  }

  async #convert(item, image) {
    for (const url of image.Path.split('|')) {
      try {
        const loaded = await this.loadContext(item.Id, { draft: item }); let primary;
        try {
          const original = [...item.ImageInfos], rows = imageRows(item);
          loaded.context.images = rows;
          await this.images.saveRemote(loaded, rows, { Url: url, Type: image.Type }, { index: 0 });
          publishNativeImageInfos(item, rows); restoreReferences(item, original);
          try { await this.updates.update(loaded, { Item: item, Images: rows }, ItemUpdateType.ImageUpdate); }
          finally { restoreReferences(item, original); }
          const result = item.ImageInfos.find(value => value.Type === image.Type);
          if (!result) throw failure(`Downloaded ${image.Type} image 0 from ${url} is not attached to ${item.Name} (${item.Id})`);
          return result;
        } catch (error) { primary = error; throw error; }
        finally {
          try { await loaded.dispose(); } catch (error) { throw primary ? new AggregateError([primary, error], primary.message, { cause: primary }) : error; }
        }
      } catch (error) {
        if ((error.code === 'http-error' || error.nativeException === 'HttpRequestException') && [403, 404].includes(error.status)) continue;
        throw error;
      }
    }
    throw failure(`Unable to convert any ${image.Type} image url in "${image.Path}" to a local file for ${item.Name} (${item.Id})`);
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#lifetime.abort();
    this.#closing = Promise.allSettled([...this.#work]).then(() => {}); return this.#closing;
  }
}
