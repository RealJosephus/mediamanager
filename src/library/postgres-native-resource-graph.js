import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { quoteIdentifier as q } from '../database/model.js';

/** Ownership metadata only. Catalogue values and native item identities never
 * enter this graph. An entity token identifies one exact JavaScript object. */
class PostgresNativeResourceGraph {
  #scope;
  #links;
  #entities = new WeakMap();
  #entityTokens = new WeakSet();
  #resources = new Map();
  #admissions = new AsyncLocalStorage();
  #tail = Promise.resolve();
  #collection;
  #epoch = 0;
  #collectedEpoch = -1;
  #errors = [];
  #fatal;
  #waiters = new Set();
  #closing = false;
  #closed = false;
  #closePromise;

  constructor(linkedChildren, scope) {
    this.#links = linkedChildren;
    this.#scope = scope;
    const prefix = 'native_resource_' + randomUUID().replaceAll('-', '');
    const table = name => `${q(linkedChildren.schemaName)}.${q(prefix + '_' + name)}`;
    this.tables = Object.freeze({ entities: table('entities'), resources: table('resources'),
      roots: table('roots'), edges: table('edges') });
  }

  async initialize() {
    const { entities, resources, roots, edges } = this.tables;
    await this.#scope.run(db => db.client.query(`
      CREATE TABLE ${entities}(id uuid PRIMARY KEY);
      CREATE TABLE ${resources}(id uuid PRIMARY KEY,entity_id uuid REFERENCES ${entities}(id),prepared boolean NOT NULL);
      CREATE TABLE ${roots}(token uuid PRIMARY KEY,entity_id uuid REFERENCES ${entities}(id),
        resource_id uuid REFERENCES ${resources}(id) ON DELETE CASCADE,
        CHECK ((entity_id IS NOT NULL)::integer+(resource_id IS NOT NULL)::integer=1));
      CREATE TABLE ${edges}(token uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES ${resources}(id) ON DELETE CASCADE,
        entity_id uuid NOT NULL REFERENCES ${entities}(id),slot_id uuid,UNIQUE(source_id,slot_id));
      CREATE INDEX ON ${resources}(entity_id);
      CREATE INDEX ON ${resources}(id) WHERE NOT prepared;
      CREATE INDEX ON ${edges}(source_id);
      CREATE INDEX ON ${edges}(entity_id);
      CREATE INDEX ON ${roots}(entity_id);
      CREATE INDEX ON ${roots}(resource_id)`));
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

  #record(error) {
    if (!this.#errors.includes(error)) this.#errors.push(error);
  }

  #throwErrors() {
    if (this.#errors.length === 1) throw this.#errors[0];
    if (this.#errors.length) throw new AggregateError(this.#errors, 'Native cache resource cleanup failed.',
      { cause: this.#errors[0] });
  }

  #enqueue(operation, { connection = true } = {}) {
    const work = this.#tail.then(() => connection ? this.#scope.run(operation) : this.#scope.admit(operation));
    this.#tail = work.catch(error => { this.#record(error); this.#fatal ??= error; });
    return work;
  }

  #mutate(operation, collect = false, options) {
    this.#epoch++;
    const work = this.#enqueue(operation, options);
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
      const id = randomUUID();
      entity = Object.freeze({ id, retain: () => this.#root({ entityId: id }) });
      this.#entities.set(value, entity); this.#entityTokens.add(entity);
    }
    return entity;
  }

  #root({ entityId = null, resourceId = null }, owned = false) {
    this.#active(owned);
    if (resourceId && this.#resources.get(resourceId)?.state !== 'active') {
      throw new Error('The native cache resource has been retired.');
    }
    const token = randomUUID();
    this.#mutate(async db => {
      if (entityId) await db.client.query(`INSERT INTO ${this.tables.entities}(id) VALUES($1) ON CONFLICT DO NOTHING`, [entityId]);
      await db.client.query(`INSERT INTO ${this.tables.roots}(token,entity_id,resource_id) VALUES($1,$2,$3)`,
        [token, entityId, resourceId]);
    });
    let released = false;
    const lease = {
      retain: () => {
        if (released) throw new Error('The native cache owner has been released.');
        return this.#root({ entityId, resourceId }, true);
      },
      run: operation => {
        if (typeof operation !== 'function') throw new TypeError('An admitted native cache callback is required.');
        // This clone outlives the caller's lease. Inherited async contexts lose
        // admission when the callback settles, even if they still hold ALS.
        const retained = lease.retain(), admission = { active: true };
        return this.#scope.admit(() => this.#admissions.run(admission, async () => {
          try { return await operation(); }
          finally { admission.active = false; retained.release(); }
        }));
      },
      release: () => {
        if (released) return;
        released = true;
        this.#mutate(db => db.client.query(`DELETE FROM ${this.tables.roots} WHERE token=$1`, [token]), true);
      },
    };
    return Object.freeze(lease);
  }

  /** Bind while an external owner or an existing cache edge owns the entity.
   * detach must synchronously withdraw the current cache binding. release may
   * use the max=1 relation pool: collection never calls it with a connection. */
  async bind(entity, { detach, release, prepare }) {
    this.#active(); this.#checkEntity(entity);
    if (typeof detach !== 'function' || typeof release !== 'function') {
      throw new TypeError('Synchronous detach and asynchronous release callbacks are required.');
    }
    if (prepare !== undefined && typeof prepare !== 'function') throw new TypeError('A resource preparation callback is required.');
    const id = randomUUID(), entry = { detach, release, prepare, revision: 0, state: 'active' };
    this.#resources.set(id, entry);
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
        this.#mutate(db => db.client.query(`UPDATE ${this.tables.resources} SET prepared=FALSE WHERE id=$1`, [id]), true);
      },
      replaceLinks: children => {
        active();
        if (typeof children?.[Symbol.iterator] !== 'function') throw new TypeError('An iterable of exact entity tokens is required.');
        return this.#mutate(async () => {
          await this.#scope.run(db => db.client.query(`DELETE FROM ${this.tables.edges} WHERE source_id=$1`, [id]));
          let batch = [];
          const flush = async () => {
            if (!batch.length) return;
            await this.#scope.run(async db => {
              await db.client.query(`INSERT INTO ${this.tables.entities}(id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`, [batch]);
              const values = [id], tuples = batch.map(child => {
                values.push(randomUUID(), child); return `($${values.length - 1},$1,$${values.length})`;
              });
              await db.client.query(`INSERT INTO ${this.tables.edges}(token,source_id,entity_id) VALUES ${tuples.join(',')}`, values);
            });
            batch = [];
          };
          // Iteration may register each child's basic resource. Keep that
          // callback outside a connection while the complete replacement
          // still occupies one mutation-tail entry through its final batch.
          for (const child of children) {
            this.#checkEntity(child); batch.push(child.id);
            if (batch.length === 128) await flush();
          }
          await flush();
        }, false, { connection: false });
      },
      link: (child, { slot = null } = {}) => {
        active(); this.#checkEntity(child);
        const token = randomUUID();
        this.#mutate(async db => {
          await db.client.query(`INSERT INTO ${this.tables.entities}(id) VALUES($1) ON CONFLICT DO NOTHING`, [child.id]);
          await db.client.query(`INSERT INTO ${this.tables.edges}(token,source_id,entity_id,slot_id) VALUES($1,$2,$3,$4)
            ON CONFLICT(source_id,slot_id) DO UPDATE SET token=EXCLUDED.token,entity_id=EXCLUDED.entity_id`, [token, id, child.id, slot]);
        });
        let released = false;
        return Object.freeze({ release: () => {
          if (released) return;
          released = true;
          if (!this.#closed) this.#mutate(db => db.client.query(`DELETE FROM ${this.tables.edges} WHERE token=$1`, [token]), true);
        } });
      },
      unbind: () => {
        if (this.#closed || unbound || entry.state !== 'active') return;
        unbound = true;
        this.#mutate(db => db.client.query(`UPDATE ${this.tables.resources} SET entity_id=NULL WHERE id=$1`, [id]), true);
      },
    });
    entry.resource = resource;
    try {
      await this.#mutate(async db => {
        await db.client.query(`INSERT INTO ${this.tables.entities}(id) VALUES($1) ON CONFLICT DO NOTHING`, [entity.id]);
        await db.client.query(`INSERT INTO ${this.tables.resources}(id,entity_id,prepared) VALUES($1,$2,$3)`, [id, entity.id, !prepare]);
      });
    } catch (error) { this.#resources.delete(id); throw error; }
    return resource;
  }

  #reachability() {
    const { roots, resources, edges } = this.tables;
    return `WITH RECURSIVE reachable(kind,id) AS (
      SELECT seed.kind,seed.id FROM (
        SELECT 0 AS kind,entity_id AS id FROM ${roots} WHERE entity_id IS NOT NULL
        UNION SELECT 1,resource_id FROM ${roots} WHERE resource_id IS NOT NULL) seed
      UNION
      SELECT hop.kind,hop.id FROM reachable frontier CROSS JOIN LATERAL (
        SELECT 1 AS kind,resource.id FROM ${resources} resource WHERE frontier.kind=0 AND resource.entity_id=frontier.id
        UNION ALL SELECT 0,edge.entity_id FROM ${edges} edge WHERE frontier.kind=1 AND edge.source_id=frontier.id
      ) hop
    )`;
  }

  #unreachable() {
    return `${this.#reachability()} SELECT resource.id FROM ${this.tables.resources} resource
      WHERE NOT EXISTS(SELECT 1 FROM reachable live WHERE live.kind=1 AND live.id=resource.id)
      ORDER BY resource.id LIMIT 128`;
  }

  async #pruneEntities() {
    const { entities, resources, roots, edges } = this.tables;
    // Entity creation and its root, binding or edge are one queued mutation.
    // Pruning between their INSERTs would remove the referenced entity.
    await this.#enqueue(db => db.client.query(`DELETE FROM ${entities} entity
      WHERE NOT EXISTS(SELECT 1 FROM ${resources} resource WHERE resource.entity_id=entity.id)
      AND NOT EXISTS(SELECT 1 FROM ${roots} root WHERE root.entity_id=entity.id)
      AND NOT EXISTS(SELECT 1 FROM ${edges} edge WHERE edge.entity_id=entity.id)`));
  }

  async #collect() {
    for (;;) {
      const tail = this.#tail;
      await tail;
      if (tail !== this.#tail) continue;
      if (this.#fatal) return;
      const epoch = this.#epoch;
      const pending = await this.#scope.run(async db => (await db.client.query(`${this.#reachability()}
        SELECT resource.id FROM ${this.tables.resources} resource WHERE NOT resource.prepared
        AND EXISTS(SELECT 1 FROM reachable live WHERE live.kind=1 AND live.id=resource.id)
        ORDER BY resource.id LIMIT 128`)).rows);
      if (epoch !== this.#epoch) continue;
      if (pending.length) {
        for (const row of pending) {
          if (epoch !== this.#epoch) break;
          const entry = this.#resources.get(row.id);
          if (!entry?.prepare || entry.state !== 'active') throw new Error('A pending SQL resource is missing its active preparation callback.');
          const revision = entry.revision, admission = { active: true };
          // Preparation reads only this resource's direct children. SQL finds
          // the next reachable pending resource; no callback walks the graph.
          try { await this.#admissions.run(admission, () => entry.prepare(entry.resource)); }
          finally { admission.active = false; }
          if (entry.revision === revision) await this.#enqueue(db => db.client.query(
            `UPDATE ${this.tables.resources} SET prepared=TRUE WHERE id=$1`, [row.id]));
        }
        continue;
      }
      // Returning from run releases the relation connection before callbacks.
      const rows = await this.#scope.run(async db => (await db.client.query(this.#unreachable())).rows);
      if (epoch !== this.#epoch) continue;
      if (!rows.length) {
        await this.#pruneEntities();
        if (epoch !== this.#epoch) continue;
        this.#collectedEpoch = epoch; return;
      }
      for (const row of rows) {
        if (epoch !== this.#epoch) break;
        const entry = this.#resources.get(row.id);
        if (!entry) throw new Error('A SQL cache resource is missing its active release callback.');
        // The epoch check, retirement and detach form one synchronous boundary.
        // An owner admitted while the SQL mark awaited cancels that mark.
        entry.state = 'retired';
        try {
          const pending = entry.detach();
          if (pending && typeof pending.then === 'function') {
            this.#record(new TypeError('Native cache detach must complete synchronously.'));
            try { await pending; } catch (error) { this.#record(error); }
          }
        } catch (error) { this.#record(error); }
        try { await entry.release(); } catch (error) { this.#record(error); }
        await this.#scope.run(db => db.client.query(`DELETE FROM ${this.tables.resources} WHERE id=$1`, [row.id]));
        entry.state = 'disposed'; this.#resources.delete(row.id); this.#changed();
      }
    }
  }

  #requestCollection() {
    if (this.#closed || this.#collection) return;
    const work = this.#links.queueOwnedRelease(async () => {
      try { await this.#collect(); }
      catch (error) { this.#record(error); this.#fatal ??= error; }
    });
    this.#collection = work.finally(() => {
      this.#collection = null; this.#changed();
      if (!this.#fatal && !this.#closed && this.#collectedEpoch !== this.#epoch) this.#requestCollection();
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

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    return this.#closePromise = (async () => {
      try {
        for (;;) {
          this.#requestCollection(); await this.#drain();
          if (this.#fatal) throw this.#fatal;
          const epoch = this.#epoch;
          const state = await this.#scope.run(async db => (await db.client.query(`SELECT
            EXISTS(SELECT 1 FROM ${this.tables.roots}) AS roots,
            EXISTS(SELECT 1 FROM ${this.tables.resources}) AS resources`)).rows[0]);
          if (epoch !== this.#epoch) continue;
          if (!state.roots && !state.resources) break;
          await new Promise(resolve => this.#waiters.add(resolve));
        }
        await this.#pruneEntities();
        await this.#scope.run(db => db.client.query(`DROP TABLE ${this.tables.edges},${this.tables.roots},${this.tables.resources},${this.tables.entities}`));
      } finally { this.#closed = true; this.#scope.release(); this.#changed(); }
      this.#throwErrors();
    })();
  }
}

/** Cache bindings follow SQL reachability, independently of ordinary owner
 * reference counts. Callers integrate their external roots and exact edges. */
export async function createPostgresNativeResourceGraph({ linkedChildren } = {}) {
  if (typeof linkedChildren?.admitScope !== 'function' || typeof linkedChildren?.queueOwnedRelease !== 'function') {
    throw new TypeError('The native resource graph requires an active SQL link owner.');
  }
  const scope = linkedChildren.admitScope(), graph = new PostgresNativeResourceGraph(linkedChildren, scope);
  try { await graph.initialize(); return graph; }
  catch (error) { scope.release(); throw error; }
}
