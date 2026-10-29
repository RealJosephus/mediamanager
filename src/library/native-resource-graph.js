import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

const observeGraph = Symbol('observe native resource graph');

/** Process-local ownership only. Tokens identify exact objects and resources;
 * catalogue values, identities, selection and paging remain in PostgreSQL.
 * Metadata is O(live admitted roots, bindings and edges), not a catalogue map. */
class NativeResourceGraph {
  #scope;
  #links;
  #entities = new WeakMap();
  #entityTokens = new WeakSet();
  #bindings = new Map();
  #resources = new Map();
  #roots = new Map();
  #admissions = new AsyncLocalStorage();
  #tail = Promise.resolve();
  #collection;
  #epoch = 0;
  #collectedEpoch = -1;
  #errors = [];
  #fatalPresent = false;
  #waiters = new Set();
  #closing = false;
  #closed = false;
  #closePromise;
  #observers;

  constructor(linkedChildren, scope) {
    this.#links = linkedChildren;
    this.#scope = scope;
  }

  [observeGraph](listener) {
    if (typeof listener !== 'function') throw new TypeError('A native resource observer is required.');
    (this.#observers ??= new Set()).add(listener);
    this.#observe('observed', { roots: this.#roots, resources: this.#resources });
    return Object.freeze({ release: () => {
      this.#observers?.delete(listener);
      if (!this.#observers?.size) this.#observers = undefined;
    } });
  }

  #observe(event, detail, source = false) {
    // No stacks, snapshots or diagnostic records are allocated without an
    // explicitly installed observer. Observation never owns a graph lease.
    if (!this.#observers?.size) return;
    try {
      const root = current => ({ token: current.token, entityId: current.entityId,
        resourceId: current.resourceId, references: current.references });
      const resource = current => ({ id: current.id, entityId: current.entityId, state: current.state,
        revision: current.revision, preparedRevision: current.preparedRevision });
      const value = { event };
      if (detail?.root) value.root = root(detail.root);
      if (detail?.entry) value.resource = resource(detail.entry);
      if (detail?.entityId) value.resource.entityId = detail.entityId;
      for (const [key, describe] of [['roots', root], ['resources', resource]]) {
        if (!detail?.[key]) continue;
        value[key + 'Count'] = detail[key].size;
        value[key] = [];
        for (const current of detail[key].values()) {
          if (value[key].length === 64) break;
          value[key].push(describe(current));
        }
      }
      if (source) value.source = new Error('Native resource ownership').stack?.split('\n').slice(2, 10).join('\n').slice(0, 2400);
      for (const listener of this.#observers) {
        try { listener(value); } catch { /* Diagnostics cannot change ownership or failure reasons. */ }
      }
    } catch { /* Optional diagnostic formatting cannot change the actual operation. */ }
  }

  #active(owned = false) {
    if (this.#closed || this.#closing && !owned && this.#admissions.getStore()?.active !== true) {
      throw new Error('The native resource graph is not accepting new owners.');
    }
  }

  #changed() {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  #fail(error) {
    this.#errors.push(error);
    this.#fatalPresent = true;
  }

  #throwErrors() {
    if (this.#errors.length === 1) throw this.#errors[0];
    if (this.#errors.length) throw new AggregateError(this.#errors, 'Native cache resource cleanup failed.',
      { cause: this.#errors[0] });
  }

  #enqueue(operation) {
    // Prepare/release callbacks run outside this tail. A direct-member iterator
    // runs here without a SQL lease and may admit, but never await, child binds.
    const admission = this.#admissions.getStore();
    // Capture the owner on acceptance, even if the work settles after it exits.
    const preparation = admission?.preparation === true && admission.active ? admission : null;
    const work = this.#tail.then(() => this.#scope.admit(operation));
    this.#tail = work.catch(error => {
      this.#fail(error);
      if (preparation) preparation.failedMutations.push(error);
    });
    return work;
  }

  #mutate(operation, collect = false) {
    this.#epoch++;
    const work = this.#enqueue(operation);
    this.#changed();
    if (collect) this.#requestCollection();
    return work;
  }

  #checkEntity(entity) {
    if (!entity || !this.#entityTokens.has(entity)) throw new TypeError('An entity token from this resource graph is required.');
  }

  entity(value) {
    this.#active();
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      throw new TypeError('A native resource entity requires an exact object.');
    }
    let entity = this.#entities.get(value);
    if (!entity) {
      const id = Symbol('native entity');
      entity = Object.freeze({ id, retain: () => this.#root({ entityId: id }) });
      this.#entities.set(value, entity);
      this.#entityTokens.add(entity);
    }
    return entity;
  }

  #root({ entityId = null, resourceId = null }) {
    this.#active();
    if (resourceId && this.#resources.get(resourceId)?.state !== 'active') {
      throw new Error('The native cache resource has been retired.');
    }
    const root = { token: Symbol('native root'), entityId, resourceId, references: 1 };
    this.#mutate(() => this.#roots.set(root.token, root));
    if (this.#observers) this.#observe('root-acquired', { root }, true);
    return this.#rootLease(root);
  }

  #rootLease(root) {
    let released = false;
    const lease = {
      retain: () => {
        if (released) throw new Error('The native cache owner has been released.');
        this.#active(true);
        if (root.resourceId && this.#resources.get(root.resourceId)?.state !== 'active') {
          throw new Error('The native cache resource has been retired.');
        }
        root.references++;
        this.#epoch++;
        this.#changed();
        if (this.#observers) this.#observe('root-retained', { root }, true);
        return this.#rootLease(root);
      },
      run: operation => {
        if (typeof operation !== 'function') throw new TypeError('An admitted native cache callback is required.');
        const retained = lease.retain(), admission = { active: true };
        return this.#scope.admit(() => this.#admissions.run(admission, async () => {
          try { return await operation(); }
          finally { admission.active = false; retained.release(); }
        }));
      },
      release: () => {
        if (released) return;
        released = true;
        --root.references;
        if (this.#observers) this.#observe('root-released', { root }, true);
        if (root.references === 0) {
          if (this.#closed) this.#roots.delete(root.token);
          else this.#mutate(() => this.#roots.delete(root.token), true);
        } else {
          this.#epoch++;
          this.#changed();
        }
      },
    };
    return Object.freeze(lease);
  }

  #bindEntity(entry, entityId) {
    if (entry.entityId !== null) {
      const previous = this.#bindings.get(entry.entityId);
      previous?.delete(entry.id);
      if (!previous?.size) this.#bindings.delete(entry.entityId);
    }
    entry.entityId = entityId;
    if (entityId !== null) {
      let resources = this.#bindings.get(entityId);
      if (!resources) this.#bindings.set(entityId, resources = new Set());
      resources.add(entry.id);
    }
  }

  /** Callbacks may borrow the max=1 relation pool or reenter this graph.
   * Retirement and detach are synchronous; release may complete asynchronously. */
  async bind(entity, { detach, release, prepare }) {
    this.#active(); this.#checkEntity(entity);
    if (typeof detach !== 'function' || typeof release !== 'function') {
      throw new TypeError('Synchronous detach and asynchronous release callbacks are required.');
    }
    if (prepare !== undefined && typeof prepare !== 'function') throw new TypeError('A resource preparation callback is required.');
    const id = Symbol('native resource');
    const entry = { id, entityId: null, detach, release, prepare, revision: 0,
      preparedRevision: prepare ? -1 : 0, state: 'active', edges: new Map(), slots: new Map() };
    let unbound = false;
    const active = () => {
      this.#active();
      if (entry.state !== 'active') throw new Error('The native cache resource has been retired.');
    };
    const resource = Object.freeze({ id,
      retain: () => { active(); return this.#root({ resourceId: id }); },
      refresh: () => {
        if (this.#closed || entry.state !== 'active' || !entry.prepare) return;
        entry.revision++;
        this.#epoch++;
        this.#changed();
        this.#requestCollection();
      },
      replaceLinks: children => {
        active();
        if (typeof children?.[Symbol.iterator] !== 'function') throw new TypeError('An iterable of exact entity tokens is required.');
        return this.#mutate(() => {
          entry.edges.clear(); entry.slots.clear();
          // Withdraw the old edges before reading the existing direct members.
          // A throwing iterator leaves its accepted prefix and a fatal tail;
          // it cannot silently restore old edges or acquire a SQL connection.
          for (const child of children) {
            this.#checkEntity(child);
            entry.edges.set(Symbol('native edge'), { entityId: child.id, slot: null });
          }
        });
      },
      link: (child, { slot = null } = {}) => {
        active(); this.#checkEntity(child);
        if (slot !== null && typeof slot !== 'string' && typeof slot !== 'symbol') {
          throw new TypeError('A native cache edge slot requires an opaque token.');
        }
        const token = Symbol('native edge');
        this.#mutate(() => {
          if (slot !== null) {
            const previous = entry.slots.get(slot);
            if (previous) entry.edges.delete(previous);
            entry.slots.set(slot, token);
          }
          entry.edges.set(token, { entityId: child.id, slot });
        });
        let released = false;
        return Object.freeze({ release: () => {
          if (released) return;
          released = true;
          if (!this.#closed) this.#mutate(() => {
            entry.edges.delete(token);
            if (slot !== null && entry.slots.get(slot) === token) entry.slots.delete(slot);
          }, true);
        } });
      },
      unbind: () => {
        if (this.#closed || unbound || entry.state !== 'active') return;
        unbound = true;
        this.#mutate(() => this.#bindEntity(entry, null), true);
      },
    });
    entry.resource = resource;
    if (this.#observers) this.#observe('resource-binding', { entry, entityId: entity.id }, true);
    try {
      await this.#mutate(() => {
        this.#resources.set(id, entry);
        this.#bindEntity(entry, entity.id);
      });
    } catch (error) {
      this.#resources.delete(id);
      this.#bindEntity(entry, null);
      throw error;
    }
    return resource;
  }

  async #reachable(epoch) {
    const entities = new Set(), resources = new Set(), pending = [];
    for (const root of this.#roots.values()) pending.push(root);
    let work = 0;
    while (pending.length) {
      const { entityId = null, resourceId = null } = pending.pop();
      if (entityId !== null && !entities.has(entityId)) {
        entities.add(entityId);
        for (const id of this.#bindings.get(entityId) ?? []) pending.push({ resourceId: id });
      }
      if (resourceId !== null && !resources.has(resourceId)) {
        const entry = this.#resources.get(resourceId);
        if (entry?.state === 'active') {
          resources.add(resourceId);
          for (const edge of entry.edges.values()) pending.push(edge);
        }
      }
      if (++work === 256) {
        work = 0;
        await yieldToEventLoop();
        if (epoch !== this.#epoch) return null;
      }
    }
    return resources;
  }

  async #collect() {
    for (;;) {
      const tail = this.#tail;
      await tail;
      if (tail !== this.#tail) continue;
      if (this.#fatalPresent) return;
      const epoch = this.#epoch, reachable = await this.#reachable(epoch);
      if (epoch !== this.#epoch) continue;
      const pending = [], unreachable = [];
      for (const entry of this.#resources.values()) {
        if (!reachable.has(entry.id)) unreachable.push(entry);
        else if (entry.prepare && entry.preparedRevision !== entry.revision) pending.push(entry);
      }
      if (pending.length) {
        for (const entry of pending) {
          if (epoch !== this.#epoch) break;
          const revision = entry.revision, admission = { active: true, preparation: true, failedMutations: [] };
          try {
            if (this.#observers) this.#observe('resource-prepare-started', { entry });
            await this.#admissions.run(admission, () => entry.prepare(entry.resource));
            if (this.#observers) this.#observe('resource-prepare-completed', { entry });
          } catch (error) {
            if (this.#observers) this.#observe('resource-prepare-failed', { entry });
            // Every failed work remains recorded. Correlate only this prepare's
            // final propagation, including async/then wrappers; independent work
            // and cleanup occurrences are never deduplicated by their reason.
            if (!admission.failedMutations.some(reason => Object.is(reason, error))) this.#fail(error);
            return;
          }
          finally { admission.active = false; }
          if (entry.revision === revision) entry.preparedRevision = revision;
        }
        continue;
      }
      if (!unreachable.length) { this.#collectedEpoch = epoch; return; }
      for (const entry of unreachable) {
        if (epoch !== this.#epoch) break;
        // A new admission invalidates the mark before this synchronous boundary.
        entry.state = 'retired';
        try {
          if (this.#observers) this.#observe('resource-detach-started', { entry });
          const pending = entry.detach();
          if (pending && typeof pending.then === 'function') {
            this.#errors.push(new TypeError('Native cache detach must complete synchronously.'));
            try { await pending; } catch (error) { this.#errors.push(error); }
          }
          if (this.#observers) this.#observe('resource-detach-completed', { entry });
        } catch (error) {
          if (this.#observers) this.#observe('resource-detach-failed', { entry });
          this.#errors.push(error);
        }
        try {
          if (this.#observers) this.#observe('resource-release-started', { entry });
          await entry.release();
          if (this.#observers) this.#observe('resource-release-completed', { entry });
        } catch (error) {
          if (this.#observers) this.#observe('resource-release-failed', { entry });
          this.#errors.push(error);
        }
        this.#bindEntity(entry, null);
        entry.edges.clear(); entry.slots.clear();
        entry.state = 'disposed';
        entry.detach = null; entry.release = null; entry.prepare = null; entry.resource = null;
        this.#resources.delete(entry.id);
        this.#changed();
      }
    }
  }

  #requestCollection() {
    if (this.#closed || this.#collection) return;
    const work = this.#links.queueOwnedRelease(async () => {
      if (this.#observers) this.#observe('collection-started');
      try { await this.#collect(); }
      catch (error) { this.#fail(error); }
      finally { if (this.#observers) this.#observe('collection-completed'); }
    });
    this.#collection = work.catch(error => { this.#fail(error); }).finally(() => {
      this.#collection = null; this.#changed();
      if (!this.#fatalPresent && !this.#closed && this.#collectedEpoch !== this.#epoch) this.#requestCollection();
    });
  }

  async #drain() {
    for (;;) {
      const tail = this.#tail;
      await tail;
      const collecting = this.#collection;
      if (collecting) await collecting;
      if (tail === this.#tail && !this.#collection) return;
    }
  }

  async flush() { await this.#drain(); this.#throwErrors(); }

  async collect() {
    this.#active(true); this.#requestCollection();
    await this.flush();
  }

  #clearBookkeeping() {
    // Terminal metadata has no future execution path. Forget its references,
    // without invoking callbacks or claiming that external payloads were closed.
    for (const entry of this.#resources.values()) {
      entry.edges.clear(); entry.slots.clear(); entry.entityId = null;
      entry.detach = null; entry.release = null; entry.prepare = null; entry.resource = null;
    }
    this.#roots.clear(); this.#bindings.clear(); this.#resources.clear();
    this.#entities = new WeakMap(); this.#entityTokens = new WeakSet();
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    return this.#closePromise = (async () => {
      let failure, failed = false;
      try {
        for (;;) {
          if (this.#observers) this.#observe('close-drain-started');
          this.#requestCollection(); await this.#drain();
          if (this.#observers) this.#observe('close-drain-completed',
            { roots: this.#roots, resources: this.#resources });
          if (this.#fatalPresent) this.#throwErrors();
          if (!this.#roots.size && !this.#resources.size) break;
          if (this.#observers) this.#observe('close-owner-wait-started');
          await new Promise(resolve => this.#waiters.add(resolve));
          if (this.#observers) this.#observe('close-owner-wait-completed');
        }
        this.#throwErrors();
      } catch (error) { failure = error; failed = true; }
      finally {
        this.#closed = true;
        this.#clearBookkeeping();
        try { this.#scope.release(); }
        catch (cleanup) {
          failure = failed ? new AggregateError([failure, cleanup], failure?.message ?? 'Native resource graph close failed.',
            { cause: failure }) : cleanup;
          failed = true;
        }
        this.#changed();
      }
      if (failed) throw failure;
    })();
  }
}

/** Observe actual ownership and cleanup boundaries without retaining a root. */
export function observeNativeResourceGraph(graph, listener) {
  if (!(graph instanceof NativeResourceGraph)) throw new TypeError('A native resource graph is required.');
  return graph[observeGraph](listener);
}

export async function createNativeResourceGraph({ linkedChildren } = {}) {
  if (typeof linkedChildren?.admitScope !== 'function' || typeof linkedChildren?.queueOwnedRelease !== 'function') {
    throw new TypeError('The native resource graph requires an active link owner.');
  }
  const scope = linkedChildren.admitScope();
  try { return new NativeResourceGraph(linkedChildren, scope); }
  catch (error) {
    try { scope.release(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Native resource graph construction failed.', { cause: error }); }
    throw error;
  }
}
