import { randomUUID } from 'node:crypto';
import { idKey, libraryError } from '../library/records.js';
import { loadLocalizationData } from '../core/localization-data.js';
import { applyItemMetadataUpdate, metadataEditFlags, peopleItemTypes } from './item-update.js';
import { ItemUpdateType, validateMetadataSaves } from './save-manager.js';
import { saveMetadataItem } from './save-item.js';
import { assertKnownItem } from './editor-service.js';
import { clrTrim } from './whitespace.js';
import { onMetadataChanged } from './metadata-changed.js';
import { cloneNativeItemEntity, acquireNativeItemLinkOwner } from '../library/native-item-entity.js';
import { loadPostgresRowsByIds, loadPostgresPageGraph } from '../library/postgres-library-query.js';
import { createNativeItemCohort } from '../library/native-item-cohort.js';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { captureMetadataEditSelection } from './edit-selection.js';

export class MetadataEditService {
  #closed = false;
  #pending = new Set();
  constructor({ library, loadContext, updates, refreshes, localizationData = loadLocalizationData() }) {
    Object.assign(this, { library, loadContext, updates, refreshes, localizationData });
  }

  update(itemId, request, { user = null } = {}) {
    if (this.#closed) return Promise.reject(libraryError(503, 'Metadata editing is closing.'));
    const operation = this.library.store.serializeWrites(async database => {
      const linkedChildren = this.library.options.linkedChildren;
      const cohort = await createNativeItemCohort({ linkedChildren });
      const relation = q('mm_edit_' + randomUUID().replaceAll('-', ''));
      let rootContext, rootOwner, state, failure;
      try {
        state = await this.library.load(database, user, { includeUserData: false, includeLinkGraph: false,
          baseRows: await loadPostgresPageGraph(database, await loadPostgresRowsByIds(database, [itemId]), [], { includeManualLinks: false }) });
        const target = state.byId.get(idKey(itemId));
        if (!target || user && !await this.library.isItemVisible(target, user, state)) throw libraryError(404, 'Item not found.');
        assertKnownItem(target);
        if (!this.loadContext || !this.updates || target.NativeType.startsWith('Plugin.')) {
          throw libraryError(501, `Metadata editing is not implemented for '${target.NativeType}'.`);
        }
        const flags = metadataEditFlags(target, request), sql = nativeTextSql(database.schemaName);
        rootContext = await this.loadContext(target.Id, { includeChildren: false });
        await validateMetadataSaves(rootContext, ItemUpdateType.MetadataEdit, this.updates.registry);
        const item = cloneNativeItemEntity(rootContext.item);
        rootOwner = acquireNativeItemLinkOwner(item);
        await captureMetadataEditSelection({ database, library: this.library, loadContext: this.loadContext,
          updates: this.updates, root: item, lockChanged: flags.lockChanged, cohort, relation });

        const ancestors = new Map([[idKey(item.Id), item]]);
        const children = async function* (parent) {
          await cohort.flush();
          const view = await cohort.view({ session: database, plan: {
            text: `SELECT "Ordinal","SlotKey" FROM ${relation} WHERE "Physical" AND ${sql.guidKey('"ParentId"')}=$1 ORDER BY "Ordinal"`,
            values: [idKey(parent.Id)] } });
          try {
            for (let after = 0n; ;) {
              const page = await view.page({ after, limit: 128 });
              try {
                if (!page.entries.length) break;
                for (const entry of page.entries) {
                  ancestors.set(idKey(parent.Id), parent);
                  try { yield entry.item; }
                  finally { if (parent !== item) ancestors.delete(idKey(parent.Id)); }
                }
                after = page.entries.at(-1).Ordinal;
              } finally { await page.release(); }
            }
          } finally { await view.release(); }
        };
        const people = request.People != null && peopleItemTypes.has(item.Type)
          ? request.People.map(person => ({ Name: clrTrim(person.Name), Role: person.Role == null ? '' : clrTrim(person.Role), Type: person.Type })) : null;
        if (people != null) {
          await this.updates.updatePeople(rootContext, people);
          await this.loadContext.withContext(target.Id, { includeChildren: false }, context => { rootContext.context.people = context.context.people; });
        }
        const save = async (updatedItem, { recalculateRating = true } = {}) => this.loadContext.withContext(updatedItem.Id,
          { draft: updatedItem, includeChildren: false }, async context => {
            // Descendant saves consume this edit's live ancestors, including
            // the CollectionFolder reached through a cached physical root.
            // Its newly committed tags must feed the child's inherited rows.
            const currentSource = source => ancestors.get(idKey(source.Id)) ?? source;
            context.parents = (context.parents ?? []).map(currentSource);
            context.parent = context.parents[0];
            context.collectionFolders = (context.collectionFolders ?? []).map(currentSource);
            if (recalculateRating) onMetadataChanged(updatedItem, await context.parentalRating(updatedItem, ancestors));
            const result = { Item: cloneNativeItemEntity(updatedItem) }, owner = acquireNativeItemLinkOwner(result.Item);
            try { await saveMetadataItem(this.updates, context, result, ItemUpdateType.MetadataEdit); }
            finally { owner.release(); }
          });
        await applyItemMetadataUpdate(item, request, { children, save,
          findLanguage: value => this.localizationData.findLanguage(value)?.TwoLetterISOLanguageName ?? value });
        await save(item);
        if (flags.lockChanged && item.IsFolder) {
          for (let after = 0n; ;) {
            const page = await cohort.page({ after, limit: 128 });
            try {
              if (!page.entries.length) break;
              for (const entry of page.entries) {
                entry.item.IsLocked = item.IsLocked;
                await save(entry.item, { recalculateRating: false });
              }
              after = page.entries.at(-1).Ordinal;
            } finally { await page.release(); }
          }
        }
        if (flags.displayOrderChanged) void this.refreshes?.queue(item.Id, {
          MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'FullRefresh', ReplaceAllMetadata: true
        }, 0).catch(error => this.updates.logger.error(error, 'Error refreshing edited series display order'));
      } catch (error) { failure = error; throw error; }
      finally {
        const errors = [];
        for (const cleanup of [() => rootOwner?.release(), () => rootContext?.dispose(), () => state?.dispose(),
          () => cohort.release(), () => database.client.query(`DROP TABLE IF EXISTS ${relation}`), () => linkedChildren.flushReleases()]) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
          failure?.message ?? 'Metadata edit ownership cleanup failed.', failure ? { cause: failure } : undefined);
      }
    });
    this.#pending.add(operation);
    void operation.then(() => this.#pending.delete(operation), () => this.#pending.delete(operation));
    return operation;
  }

  async close() { this.#closed = true; await Promise.allSettled([...this.#pending]); }
}
