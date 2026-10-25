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
  constructor({ linkedChildren, view, itemCreation, store, count, scope, collection }) {
    Object.assign(this, { linkedChildren, view, itemCreation, store, count, scope, collection });
    this.#releaseScope = scope.acquire();
    this.#collectionOwner = itemCreation.retainItem(collection);
  }
  retain() {
    if (this.#released) throw new Error('Collection event items have been released.');
    return new CollectionEventItems({ linkedChildren: this.linkedChildren, view: this.view.retain(),
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
      const failures = [];
      try { await captured?.release(); } catch (error) { failures.push(error); }
      try { await this.store.run(async session => {
        try { await retained.release({ session }); }
        finally { await this.linkedChildren.flushReleases({ session }); }
      }); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Collection event page cleanup failed.');
    };
    try {
      captured = await retained.view.page(options);
      const entries = captured.entries.map(row => ({ Ordinal: row.Ordinal, Item: row.item }));
      return Object.freeze({ entries, release });
    } catch (error) {
      try { await release(); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
      throw error;
    }
  }
  async *pages(options = {}) {
    const retained = this.retain();
    try {
      for (let after = options.after ?? 0n; ; ) {
        const page = await retained.page({ ...options, after });
        try {
          if (!page.entries.length) return;
          yield page; after = page.entries.at(-1).Ordinal;
        } finally { await page.release(); }
      }
    } finally { await retained.release(); }
  }
  async release({ session } = {}) {
    if (this.#released) return;
    this.#released = true;
    try { await this.view.release({ session }); }
    finally { try { this.#collectionOwner.release(); } finally { this.#releaseScope(); } }
  }
}
