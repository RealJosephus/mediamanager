import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { StorageError } from '../storage/errors.js';
import { postgresUserDataKeyMap } from '../sessions/user-data.js';
import { idKey, VIDEO_TYPES } from './records.js';
import { nativePathKey } from './native-path.js';
import { isFileProtocol } from './owned-items.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { metadataChildSequence } from './metadata-child-sequence.js';
import { buildPostgresValidationChildrenQuery, loadPostgresRowsByIds } from './postgres-library-query.js';

const encode = value => value == null ? null : nativeTextBytes(value);
const pathKey = value => value ? encode(ordinalIgnoreCaseKey(value)) : null;
const type = item => item.NativeType?.split('.').at(-1);

async function releaseResources(failed, failure, operations) {
  const errors = [];
  for (const operation of operations) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length) {
    const error = new AggregateError(failed ? [failure, ...errors] : errors,
      failure?.message ?? 'Folder validation ownership cleanup failed.', failed ? { cause: failure } : undefined);
    if (failed) for (const key of ['code', 'status', 'statusCode']) {
      const value = failure?.[key]; if (value !== undefined) error[key] = value;
    }
    throw error;
  }
}

/** One directory's initial repository membership and reconciliation sets stay
 * in SQL. Only the resolver's own input and the native CreateItems batch are
 * retained by the caller; typed repository reads never exceed 128 children. */
class FolderValidationScope {
  constructor({ session, store, library, linkedChildren, parent }, cohort) {
    Object.assign(this, { session, store, library, linkedChildren, parent, cohort });
    const suffix = randomUUID().replaceAll('-', '');
    this.tables = Object.fromEntries(['source', 'current', 'paths', 'claims', 'valid', 'alternates',
      'removed', 'deferred', 'keys', 'matches'].map(name => [name, q('mm_folder_' + name + '_' + suffix)]));
  }

  query(text, values = []) { return this.session.client.query(text, values); }

  async capture() {
    const t = this.tables, source = buildPostgresValidationChildrenQuery(this.session, this.parent.Id);
    await this.query(`CREATE TEMP TABLE ${t.source} AS ${source.text}`, source.values);
    await this.query(`CREATE UNIQUE INDEX ON ${t.source}("Ordinal");
      CREATE TEMP TABLE ${t.current}("Key" text PRIMARY KEY,"Ordinal" bigint UNIQUE,"SlotKey" uuid NOT NULL,
        "PathKey" bytea,"IdentityPathKey" bytea,"Type" bytea,"Deletable" boolean,"Active" boolean DEFAULT TRUE);
      CREATE TEMP TABLE ${t.paths}("PathKey" bytea PRIMARY KEY,"Key" text NOT NULL);
      CREATE TEMP TABLE ${t.claims}("Key" text PRIMARY KEY,"IdentityPathKey" bytea,"Type" bytea);
      CREATE TEMP TABLE ${t.valid}("Key" text PRIMARY KEY,"Ordinal" bigint NOT NULL UNIQUE,"SlotKey" uuid NOT NULL,
        "AccessibleOrdinal" bigint UNIQUE,"AccessibleSlot" uuid);
      CREATE TEMP TABLE ${t.alternates}("Key" text,"PathKey" bytea,PRIMARY KEY("Key","PathKey"));
      CREATE INDEX ON ${t.alternates}("PathKey");
      CREATE TEMP TABLE ${t.removed}("Key" text PRIMARY KEY,"Ordinal" bigserial UNIQUE,"SlotKey" uuid NOT NULL);
      CREATE TEMP TABLE ${t.deferred}("Ordinal" bigserial PRIMARY KEY,"SlotKey" uuid,"PrimarySlot" uuid);
      CREATE TEMP TABLE ${t.keys}("Key" bytea PRIMARY KEY);
      CREATE TEMP TABLE ${t.matches}("Ordinal" bigint PRIMARY KEY,"SlotKey" uuid NOT NULL)`);
    // Validate the parent independently of child presence, including an empty
    // directory. No request cancellation is observed until capture completes.
    const parentState = await this.library.load(this.session, null, { includeUserData: false,
      baseRows: await loadPostgresRowsByIds(this.session, [this.parent.Id]) });
    let parentFailure, parentFailed = false;
    try {
      const persisted = parentState.byId.get(idKey(this.parent.Id));
      if (!persisted?.IsFolder || type(persisted) !== type(this.parent)) {
        throw Object.assign(new Error('Folder not found.'), { status: 404, statusCode: 404 });
      }
    } catch (error) { parentFailure = error; parentFailed = true; throw error; }
    finally { await releaseResources(parentFailed, parentFailure, [() => parentState.dispose({ session: this.session })]); }
    const columns = tableDefinition('BaseItems').columns;
    for (let after = 0n; ;) {
      const rows = (await this.query(`SELECT * FROM ${t.source} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
      if (!rows.length) break;
      const baseRows = rows.map(row => Object.fromEntries(columns.map(column =>
        [column.name, decodeValue(column, row[column.name], 'postgres')])));
      const state = await this.library.load(this.session, null, { includeUserData: false, baseRows });
      let failure, failed = false;
      try {
        for (const row of rows) {
          const item = state.byId.get(idKey(decodeNativeTextBytes(row.Id)));
          if (!item) continue;
          await this.query(`INSERT INTO ${t.current}("Key","Ordinal","SlotKey","PathKey","IdentityPathKey","Type","Deletable")
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT("Key") DO NOTHING`, [idKey(item.Id), row.Ordinal,
            await this.cohort.captureSlot(item), pathKey(item.Path), encode(nativePathKey(item.Path)), encode(item.NativeType),
            isFileProtocol(item) && item.CanDelete !== false && !item.IsRoot]);
        }
      } catch (error) { failure = error; failed = true; throw error; }
      finally { await releaseResources(failed, failure, [() => state.dispose({ session: this.session })]); }
      after = BigInt(rows.at(-1).Ordinal);
    }
    // TryAdd keeps the first original path occupant. Removing it must never
    // make a later same-path sibling become a replacement candidate.
    await this.query(`INSERT INTO ${t.paths} SELECT DISTINCT ON ("PathKey") "PathKey","Key" FROM ${t.current}
      WHERE "PathKey" IS NOT NULL ORDER BY "PathKey","Ordinal"`);
    await this.query(`DROP TABLE ${t.source}`);
  }

  async checkClaims(claims, deletionSafe, resolvedItems) {
    const t = this.tables;
    for (let offset = 0; offset < claims.length; offset += 128) {
      const page = claims.slice(offset, offset + 128);
      await this.query(`INSERT INTO ${t.claims} SELECT DISTINCT ON (key) key,path,type FROM
        unnest($1::text[],$2::bytea[],$3::bytea[]) WITH ORDINALITY claim(key,path,type,position) ORDER BY key,position DESC
        ON CONFLICT("Key") DO UPDATE SET "IdentityPathKey"=EXCLUDED."IdentityPathKey","Type"=EXCLUDED."Type"`,
      [page.map(claim => idKey(claim.Id)), page.map(claim => encode(nativePathKey(claim.identityPath))),
        page.map(claim => encode(claim.nativeType))]);
    }
    if ((await this.query(`SELECT EXISTS(SELECT 1 FROM ${t.current} current JOIN ${t.claims} claim USING("Key")
      WHERE current."Type" IS DISTINCT FROM claim."Type" OR current."IdentityPathKey" IS NULL
        OR current."IdentityPathKey" IS DISTINCT FROM claim."IdentityPathKey") AS invalid`)).rows[0].invalid) {
      throw new StorageError('not-supported', 'Changing an existing folder child requires structural reconciliation.');
    }
    if (!deletionSafe && (await this.query(`SELECT EXISTS(SELECT 1 FROM ${t.current} current
      WHERE "Deletable" AND NOT EXISTS(SELECT 1 FROM ${t.claims} claim WHERE claim."Key"=current."Key")) AS unsafe`)).rows[0].unsafe) {
      throw new StorageError('not-supported', 'Removing folder children requires a strong complete directory snapshot.');
    }
    if (!deletionSafe) for (const claim of claims) {
      const resolved = resolvedItems.get(idKey(claim.Id));
      if (!VIDEO_TYPES.has(resolved?.Type)) continue;
      await this.withCurrent(claim.Id, current => {
        if (!VIDEO_TYPES.has(current?.Type)) return;
        for (const field of ['AdditionalParts', 'LocalAlternateVersions']) {
          const observed = new Set((resolved[field] ?? []).map(identityPath => nativePathKey(identityPath) ?? identityPath));
          if ((current[field] ?? []).some(identityPath => !observed.has(nativePathKey(identityPath) ?? identityPath))) {
            throw new StorageError('not-supported', 'Removing an owned video declaration requires a strong complete directory snapshot.');
          }
        }
      });
    }
  }

  async withCurrent(id, operation) {
    const row = (await this.query(`SELECT "SlotKey" FROM ${this.tables.current} WHERE "Key"=$1 AND "Active"`, [idKey(id)])).rows[0];
    return row ? this.cohort.withSlot(row.SlotKey, operation) : operation(null);
  }

  async withPath(identityPath, operation) {
    const row = (await this.query(`SELECT current."SlotKey" FROM ${this.tables.paths} path
      JOIN ${this.tables.current} current USING("Key") WHERE path."PathKey"=$1 AND current."Active"`, [pathKey(identityPath)])).rows[0];
    return row ? this.cohort.withSlot(row.SlotKey, operation) : operation(null);
  }

  async forget(item) {
    await this.query(`UPDATE ${this.tables.current} SET "Active"=FALSE WHERE "Key"=$1`, [idKey(item.Id)]);
    await this.query(`DELETE FROM ${this.tables.paths} WHERE "Key"=$1`, [idKey(item.Id)]);
  }

  async valid(item, ordinal, accessible) {
    const slot = await this.cohort.captureSlot(item);
    await this.query(`INSERT INTO ${this.tables.valid} VALUES($1,$2,$3,$4,$5) ON CONFLICT("Key") DO UPDATE SET
      "SlotKey"=EXCLUDED."SlotKey","AccessibleOrdinal"=COALESCE(${this.tables.valid}."AccessibleOrdinal",EXCLUDED."AccessibleOrdinal"),
      "AccessibleSlot"=COALESCE(EXCLUDED."AccessibleSlot",${this.tables.valid}."AccessibleSlot")`,
    [idKey(item.Id), ordinal, slot, accessible ? ordinal : null, accessible ? slot : null]);
  }

  async removed(item) {
    await this.query(`INSERT INTO ${this.tables.removed}("Key","SlotKey") VALUES($1,$2)
      ON CONFLICT("Key") DO UPDATE SET "SlotKey"=EXCLUDED."SlotKey"`, [idKey(item.Id), await this.cohort.captureSlot(item)]);
  }

  async defer(item, primarySlot) {
    await this.query(`INSERT INTO ${this.tables.deferred}("SlotKey","PrimarySlot") VALUES($1,$2)`,
      [await this.cohort.captureSlot(item), primarySlot]);
    await this.removed(item);
  }

  async each(source, operation) {
    for (let after = 0n; ;) {
      const rows = (await this.query(`SELECT * FROM (${source}) selection WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
      if (!rows.length) return;
      for (const row of rows) await this.cohort.withSlot(row.SlotKey, item => operation(item, row));
      after = BigInt(rows.at(-1).Ordinal);
    }
  }

  async eachPage(source, operation) {
    const view = await this.cohort.view({ session: this.session, plan: {
      text: `SELECT "Ordinal","SlotKey" FROM (${source}) selection ORDER BY "Ordinal"`, values: [] } });
    let failure, failed = false;
    try {
      for (let after = 0n; ;) {
        const page = await view.page({ after, limit: 128 });
        let pageFailure, pageFailed = false;
        try {
          if (!page.entries.length) break;
          await operation(page.entries.map(entry => entry.item));
          after = page.entries.at(-1).Ordinal;
        } catch (error) { pageFailure = error; pageFailed = true; throw error; }
        finally { await releaseResources(pageFailed, pageFailure, [() => page.release()]); }
      }
    } catch (error) { failure = error; failed = true; throw error; }
    finally { await releaseResources(failed, failure, [() => view.release()]); }
  }

  removalPlan() {
    return `SELECT current.* FROM ${this.tables.current} current WHERE "Active"
      AND NOT EXISTS(SELECT 1 FROM ${this.tables.valid} valid WHERE valid."Key"=current."Key")`;
  }

  eachRemoval(operation) { return this.each(this.removalPlan(), operation); }
  eachDeferred(operation) {
    return this.each(`SELECT * FROM ${this.tables.deferred}`, (item, row) => this.cohort.withSlot(row.PrimarySlot, primary => operation(item, primary)));
  }
  eachDemotion(operation) {
    return this.each(`SELECT current.* FROM (${this.removalPlan()}) current
      WHERE NOT EXISTS(SELECT 1 FROM ${this.tables.removed} removed WHERE removed."Key"=current."Key")`, operation);
  }

  async captureAlternatePaths() {
    await this.each(`SELECT * FROM ${this.tables.valid}`, async item => {
      if (!VIDEO_TYPES.has(item.Type)) return;
      const paths = item.LocalAlternateVersions ?? [];
      for (let offset = 0; offset < paths.length; offset += 128) {
        await this.query(`INSERT INTO ${this.tables.alternates} SELECT $1,path FROM unnest($2::bytea[]) path
          ON CONFLICT DO NOTHING`, [idKey(item.Id), paths.slice(offset, offset + 128).filter(Boolean).map(pathKey)]);
      }
    });
  }

  async hasAlternate(identityPath) {
    return (await this.query(`SELECT EXISTS(SELECT 1 FROM ${this.tables.alternates} WHERE "PathKey"=$1) AS present`, [pathKey(identityPath)])).rows[0].present;
  }

  async primaryFor(paths, operation) {
    // Each path array belongs to one already captured Video, never a library
    // candidate set. The winner and its valid-child order are selected by SQL.
    const row = (await this.query(`SELECT valid."SlotKey" FROM ${this.tables.valid} valid WHERE EXISTS(
      SELECT 1 FROM ${this.tables.alternates} alternate WHERE alternate."Key"=valid."Key" AND alternate."PathKey"=ANY($1::bytea[]))
      ORDER BY valid."Ordinal" LIMIT 1`, [paths.filter(Boolean).map(pathKey)])).rows[0];
    if (row) return this.cohort.withSlot(row.SlotKey, item => operation(item, row.SlotKey));
  }

  async reattach(reattach, signal) {
    const t = this.tables;
    if (!(await this.query(`SELECT EXISTS(SELECT 1 FROM ${t.removed}) AS present`)).rows[0].present) return;
    signal?.throwIfAborted();
    // Freeze the complete key intersection before reattaching the first child.
    // A later key failure must not leave an earlier reattachment committed.
    await this.eachPage(`SELECT * FROM ${t.removed}`, async items => {
      const keys = await postgresUserDataKeyMap(this.session, items);
      await this.query(`INSERT INTO ${t.keys} SELECT unnest($1::bytea[]) ON CONFLICT DO NOTHING`,
        [items.flatMap(item => keys.get(idKey(item.Id))).map(encode)]);
    });
    await this.eachPage(`SELECT * FROM ${t.valid}`, async items => {
      const keys = await postgresUserDataKeyMap(this.session, items);
      const rows = items.flatMap(item => keys.get(idKey(item.Id)).map(key => [idKey(item.Id), encode(key)]));
      await this.query(`INSERT INTO ${t.matches} SELECT DISTINCT valid."Ordinal",valid."SlotKey"
        FROM unnest($1::text[],$2::bytea[]) requested(item_key,data_key)
        JOIN ${t.valid} valid ON valid."Key"=requested.item_key JOIN ${t.keys} removed ON removed."Key"=requested.data_key`,
      [rows.map(row => row[0]), rows.map(row => row[1])]);
    });
    await this.each(`SELECT * FROM ${t.matches}`, item => reattach(this.store, item, { signal }));
  }

  async accessible() {
    const view = await this.cohort.view({ session: this.session, plan: {
      text: `SELECT row_number() OVER(ORDER BY "AccessibleOrdinal") AS "Ordinal","AccessibleSlot" AS "SlotKey"
        FROM ${this.tables.valid} WHERE "AccessibleSlot" IS NOT NULL`, values: [] } });
    return metadataChildSequence(view, this.linkedChildren, this.store);
  }

  async close() {
    if (this.session.connectionReleaseError) return;
    try { await this.query(`DROP TABLE IF EXISTS ${Object.values(this.tables).join(',')}`); }
    catch (error) { this.session.discardConnection(error); throw error; }
  }
}

export async function withFolderValidationScope(options, operation) {
  const cohort = await createNativeItemCohort({ linkedChildren: options.linkedChildren,
    resolveLiveItem: id => options.library.itemCreation?.getCachedItemById?.(id) });
  const scope = new FolderValidationScope(options, cohort);
  let failure, failed = false;
  try { await scope.capture(); return await operation(scope); }
  catch (error) { failure = error; failed = true; throw error; }
  finally {
    await releaseResources(failed, failure, [() => scope.close(), () => cohort.release()]);
  }
}
