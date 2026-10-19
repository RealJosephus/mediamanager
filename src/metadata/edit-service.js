import { idKey, libraryError } from '../library/records.js';
import { visibleItem } from '../library/permissions.js';
import { loadLocalizationData } from '../core/localization-data.js';
import { applyItemMetadataUpdate, metadataEditFlags, peopleItemTypes } from './item-update.js';
import { ItemUpdateType, validateMetadataSaves } from './save-manager.js';
import { saveMetadataItem } from './save-item.js';
import { assertKnownItem } from './editor-service.js';
import { clrTrim } from './whitespace.js';
import { onMetadataChanged } from './metadata-changed.js';
import { cloneNativeItemEntity, acquireNativeItemLinkOwner, releaseNativeItemLinks } from '../library/native-item-entity.js';
import {loadPostgresRowsByIds,loadPostgresPageGraph} from '../library/postgres-library-query.js';
import {createNativeItemCohort} from '../library/native-item-cohort.js';
import {quoteIdentifier as q} from '../database/model.js';
import {nativeTextSql} from '../database/native-text-sql.js';
import {nativeTextBytes,decodeNativeTextBytes} from '../database/native-text.js';
import {randomUUID} from 'node:crypto';

const unsupportedTypes = new Set(['Playlist', 'PlaylistsFolder', 'UserView', 'CollectionFolder', 'AggregateFolder', 'UserRootFolder']);

export class MetadataEditService {
  #closed = false;
  #pending = new Set();
  constructor({ library, loadContext, updates, refreshes, localizationData = loadLocalizationData() }) {
    Object.assign(this, { library, loadContext, updates, refreshes, localizationData });
  }

  update(itemId, request, { user = null } = {}) {
    if (this.#closed) return Promise.reject(libraryError(503, 'Metadata editing is closing.'));
    const operation = this.library.store.serializeWrites(async database => {
      const linkedChildren=this.library.options.linkedChildren,cohort=await createNativeItemCohort({linkedChildren}),relation=q('mm_edit_'+randomUUID().replaceAll('-',''));
      let rootContext,rootOwner,item,state;
      try {
      state=await this.library.load(database,user,{includeUserData:false,includeLinkGraph:false,baseRows:await loadPostgresPageGraph(database,await loadPostgresRowsByIds(database,[itemId]),[],{includeManualLinks:false})});
      const target=state.byId.get(idKey(itemId));
      if(!target||user&&!visibleItem(target,user,state,{...this.library.options,query:false}))throw libraryError(404,'Item not found.');
      assertKnownItem(target);
      if(!this.loadContext||!this.updates||unsupportedTypes.has(target.Type)||target.NativeType.startsWith('Plugin.'))throw libraryError(501,`Metadata editing is not implemented for '${target.NativeType}'.`);
      const flags=metadataEditFlags(target,request),sql=nativeTextSql(database.schemaName),table=`${q(database.schemaName)}.${q('BaseItems')}`,links=`${q(database.schemaName)}.${q('LinkedChildren')}`;
      rootContext=await this.loadContext(target.Id,{includeChildren:false});await validateMetadataSaves(rootContext,ItemUpdateType.MetadataEdit,this.updates.registry);item=cloneNativeItemEntity(rootContext.item);rootOwner=acquireNativeItemLinkOwner(item);
      await database.client.query(`CREATE TEMP TABLE ${relation} AS WITH RECURSIVE ranked AS MATERIALIZED (
        SELECT item.*,row_number() OVER(PARTITION BY "ParentId" ORDER BY "SortName" NULLS FIRST,"Id") AS position FROM ${table} item),walk AS (
        SELECT child."Id",child."ParentId",child."Type",child."IsFolder",ARRAY[child.position] AS route,ARRAY[${sql.guidKey('child."Id"')}] AS seen,1 AS depth FROM ranked child WHERE ${sql.guidKey('child."ParentId"')}=$1
        UNION ALL SELECT child."Id",child."ParentId",child."Type",child."IsFolder",parent.route||child.position,parent.seen||${sql.guidKey('child."Id"')},parent.depth+1 FROM walk parent JOIN ranked child ON ${sql.guidKey('child."ParentId"')}=${sql.guidKey('parent."Id"')}
        WHERE parent."IsFolder" AND NOT ${sql.guidKey('child."Id"')}=ANY(parent.seen) AND ($2::boolean OR ($3='Series' AND parent.depth=1)))
        ,selected AS (SELECT * FROM walk WHERE $2::boolean OR ($3='Series' AND ((depth=1 AND ${sql.projection('"Type"')} LIKE '%.Season') OR (depth=2 AND ${sql.projection('"Type"')} LIKE '%.Episode'))) OR ($3='Season' AND depth=1 AND ${sql.projection('"Type"')} LIKE '%.Episode') OR ($3='MusicAlbum' AND depth=1)
        UNION ALL SELECT item."Id",item."ParentId",item."Type",item."IsFolder",ARRAY[9223372036854775807::bigint,link."SortOrder"::bigint],ARRAY[${sql.guidKey('item."Id"')}],1 FROM ${links} link JOIN ${table} item ON ${sql.guidKey('item."Id"')}=${sql.guidKey('link."ChildId"')} WHERE $2::boolean AND ${sql.guidKey('link."ParentId"')}=$1)
        SELECT row_number() OVER(ORDER BY route) AS "Ordinal",selected.*,NULL::uuid AS "SlotKey" FROM (SELECT DISTINCT ON("Id") * FROM selected ORDER BY "Id",route) selected`,[idKey(target.Id),target.IsFolder&&flags.lockChanged,target.Type]);
      for(let after=0n;;){const page=(await database.client.query(`SELECT * FROM ${relation} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`,[after])).rows;if(!page.length)break;for(const row of page){const context=await this.loadContext(decodeNativeTextBytes(row.Id,'runtime'),{includeChildren:false});try{assertKnownItem(context.item);if(unsupportedTypes.has(context.item.Type)||context.item.NativeType.startsWith('Plugin.'))throw libraryError(501,'A metadata edit descendant is unsupported.');await validateMetadataSaves(context,ItemUpdateType.MetadataEdit,this.updates.registry);const owner=acquireNativeItemLinkOwner(context.item);try{const slot=await cohort.capture(context.item,{ordinal:BigInt(row.Ordinal)});await database.client.query(`UPDATE ${relation} SET "SlotKey"=$2 WHERE "Ordinal"=$1`,[row.Ordinal,slot]);}finally{owner.release();}}finally{await context.dispose();}}after=BigInt(page.at(-1).Ordinal);}
      const ancestors=new Map([[idKey(item.Id),item]]);
      const children=async function*(parent){await cohort.flush();const view=await cohort.view({session:database,plan:{text:`SELECT "Ordinal","SlotKey" FROM ${relation} WHERE ${sql.guidKey('"ParentId"')}=$1`,values:[idKey(parent.Id)]}});try{for(let after=0n;;){const page=await view.page({after,limit:128});try{if(!page.entries.length)break;for(const entry of page.entries){ancestors.set(idKey(parent.Id),parent);try{yield entry.item;}finally{if(parent!==item)ancestors.delete(idKey(parent.Id));}}after=page.entries.at(-1).Ordinal;}finally{await page.release();}}}finally{await view.release();}};
      const people = request.People != null && peopleItemTypes.has(item.Type)
        ? request.People.map(person => ({ Name: clrTrim(person.Name), Role: person.Role == null ? '' : clrTrim(person.Role), Type: person.Type })) : null;
      if (people != null) {
        await this.updates.updatePeople(rootContext,people);
        await this.loadContext.withContext(target.Id,{includeChildren:false},context=>{rootContext.context.people=context.context.people;});
      }
      const save=async(updatedItem,{recalculateRating=true}={})=>this.loadContext.withContext(updatedItem.Id,{draft:updatedItem,includeChildren:false},async context=>{if(recalculateRating)onMetadataChanged(updatedItem,context.parentalRating(updatedItem,ancestors));const result={Item:cloneNativeItemEntity(updatedItem)},owner=acquireNativeItemLinkOwner(result.Item);try{await saveMetadataItem(this.updates,context,result,ItemUpdateType.MetadataEdit);}finally{owner.release();}});
      await applyItemMetadataUpdate(item, request, { children, save,
        findLanguage: value => this.localizationData.findLanguage(value)?.TwoLetterISOLanguageName ?? value });
      await save(item);
      if(flags.lockChanged&&item.IsFolder){for(let after=0n;;){const page=await cohort.page({after,limit:128});try{if(!page.entries.length)break;for(const entry of page.entries){entry.item.IsLocked=item.IsLocked;await save(entry.item,{recalculateRating:false});}after=page.entries.at(-1).Ordinal;}finally{await page.release();}}}
      if (flags.displayOrderChanged) void this.refreshes?.queue(item.Id, {
        MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'FullRefresh', ReplaceAllMetadata: true
      }, 0).catch(error => this.updates.logger.error(error, 'Error refreshing edited series display order'));
      } finally {rootOwner?.release();await rootContext?.dispose();await state?.dispose();await cohort.release();await database.client.query(`DROP TABLE IF EXISTS ${relation}`);await linkedChildren.flushReleases();}
    });
    this.#pending.add(operation);
    void operation.then(() => this.#pending.delete(operation), () => this.#pending.delete(operation));
    return operation;
  }

  async close() { this.#closed = true; await Promise.allSettled([...this.#pending]); }
}
