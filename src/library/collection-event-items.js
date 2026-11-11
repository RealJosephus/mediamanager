import { operationFailure } from '../core/operation-failure.js';

async function releaseEventResources(releases, errors = []) {
  for (const release of releases) {
    try { await release(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw operationFailure(errors, 'Collection event resource cleanup failed.');
}

/** One event invocation borrows this bounded raw relation. A listener that
 * crosses an asynchronous boundary must synchronously retain its own lease.
 * Entries preserve the original request order and repeated new members. */
export class CollectionEventScope {
  #count = 0;
  #idle;
  acquire() {
    this.#count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#count === 0) { this.#idle?.resolve(); this.#idle = undefined; }
    };
  }
  async drain() {
    while (this.#count) { this.#idle ??= Promise.withResolvers(); await this.#idle.promise; }
  }
}

export class CollectionEventItems {
  #released = false;
  #releaseScope;
  #collectionOwner;
  constructor({ linkedChildren, view, itemCreation, store, count, scope, collection, retainView = false }) {
    Object.assign(this, { linkedChildren, view, itemCreation, store, count, scope, collection });
    this.#releaseScope = scope.acquire();
    try {
      this.#collectionOwner = itemCreation.retainItem(collection);
      // A retained view is acquired only after its synchronous owners exist.
      // A failed constructor leaves an incoming view with its original caller.
      if (retainView) this.view = view.retain();
    } catch (error) {
      const errors = [error];
      for (const release of [() => this.#collectionOwner?.release(), () => this.#releaseScope()]) {
        try { release(); } catch (cleanup) { errors.push(cleanup); }
      }
      throw operationFailure(errors, 'Collection event ownership acquisition failed.');
    }
  }
  retain() {
    if (this.#released) throw new Error('Collection event items have been released.');
    return new CollectionEventItems({ linkedChildren: this.linkedChildren, view: this.view, retainView: true,
      itemCreation: this.itemCreation, store: this.store, count: this.count, scope: this.scope, collection: this.collection });
  }
  async page(options = {}) {
    if (this.#released) throw new Error('Collection event items have been released.');
    const retained = this.retain();
    let captured;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await releaseEventResources([() => captured?.release(), async () => {
        let entered = false;
        try {
          await this.store.run(session => {
            entered = true;
            return releaseEventResources([
              () => retained.release({ session }), () => this.linkedChildren.flushReleases({ session }),
            ]);
          });
        } catch (error) {
          if (entered) throw error;
          // Failed native admission never borrowed these owners. Their SQL
          // cohort can still drain through its independent relation pool.
          await releaseEventResources([
            () => retained.release(), () => this.linkedChildren.flushReleases(),
          ], [error]);
        }
      }]);
    };
    try {
      captured = await retained.view.page(options);
      const entries = captured.entries.map(row => ({ Ordinal: row.Ordinal, Item: row.item }));
      return Object.freeze({ entries, release });
    } catch (error) {
      try { await release(); } catch (cleanup) { throw operationFailure([error, cleanup], 'Collection event page read failed.'); }
      throw error;
    }
  }
  async *pages(options = {}) {
    const retained = this.retain();
    const errors = [];
    try {
      for (let after = options.after ?? 0n; ; ) {
        const page = await retained.page({ ...options, after });
        const pageErrors = [];
        try {
          if (!page.entries.length) return;
          yield page; after = page.entries.at(-1).Ordinal;
        } catch (error) { pageErrors.push(error); throw error; }
        finally { await releaseEventResources([() => page.release()], pageErrors); }
      }
    } catch (error) { errors.push(error); throw error; }
    finally { await releaseEventResources([() => retained.release()], errors); }
  }
  async release({ session } = {}) {
    if (this.#released) return;
    this.#released = true;
    const errors = [];
    for (const release of [() => this.view.release({ session }), () => this.#collectionOwner.release(), () => this.#releaseScope()]) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw operationFailure(errors, 'Collection event ownership release failed.');
  }
}
