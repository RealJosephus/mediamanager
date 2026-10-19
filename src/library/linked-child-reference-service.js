import {randomUUID} from 'node:crypto';
import {serialize,deserialize} from 'node:v8';
import {isDeepStrictEqual} from 'node:util';
import {quoteIdentifier as q} from '../database/model.js';
import {nativeTextBytes,decodeNativeTextBytes} from '../database/native-text.js';
import {nativeTextSql} from '../database/native-text-sql.js';
import {ItemUpdateType} from '../metadata/save-manager.js';
import {StorageError} from '../storage/errors.js';
import {nativeGuid} from '../users/native.js';
import {sameId} from './records.js';
const missing=error=>error?.status===404||error?.statusCode===404||error?.code==='not-found';
export class LinkedChildReferenceService {
 constructor({store,itemCreation,loadContext,updates}){if(!store||!itemCreation||!loadContext||!updates)throw new TypeError('Linked references require native lifecycle services.');Object.assign(this,{store,itemCreation,loadContext,updates});}
 async reroute(fromChildId,toChildId){fromChildId=nativeGuid(fromChildId);toChildId=nativeGuid(toChildId);
 return this.store.serializeWrites(async db=>{
  const sql=nativeTextSql(db.schemaName),table=`${q(db.schemaName)}.${q('LinkedChildren')}`,prefix='mm_refs_'+randomUUID().replaceAll('-',''),links=q(prefix+'_links'),parents=q(prefix+'_parents'),from=fromChildId.replaceAll('-','').toLowerCase(),to=toChildId.replaceAll('-','').toLowerCase();
  const selection=`SELECT * FROM ${table} WHERE ${sql.guidKey('"ChildId"')}=ANY($1::text[])`;
  const each=async operation=>{for(let after=0n;;){const page=(await db.client.query(`SELECT * FROM ${parents} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`,[after])).rows;if(!page.length)break;for(const row of page)await operation(row);after=BigInt(page.at(-1).Ordinal);}};
  try{
   await db.client.query({text:`CREATE TEMP TABLE ${links} AS ${selection}`,values:[[from,to]]});
   await db.client.query(`CREATE TEMP TABLE ${parents} AS SELECT row_number() OVER(ORDER BY "ParentId") AS "Ordinal","ParentId",NULL::bytea AS snapshot,FALSE AS writable FROM ${links} WHERE "ChildType"=0 AND ${sql.guidKey('"ChildId"')}=$1 GROUP BY "ParentId"`,[from]);
   await each(async row=>{const id=decodeNativeTextBytes(row.ParentId,'runtime');let loaded;try{loaded=await this.loadContext(id,{includeChildren:false});}catch(error){if(missing(error))return;throw error;}try{if(!loaded?.item||!loaded.snapshot)throw new TypeError('Linked reference preflight requires an authoritative snapshot.');if(loaded.item.IsFolder)await this.updates.preflightMetadataSavers(loaded,ItemUpdateType.MetadataEdit);await db.client.query(`UPDATE ${parents} SET snapshot=$2,writable=$3 WHERE "Ordinal"=$1`,[row.Ordinal,serialize(loaded.snapshot),loaded.item.IsFolder===true]);}finally{await loaded.dispose();}});
   if(!(await db.client.query(`SELECT EXISTS(SELECT 1 FROM ${parents}) AS any`)).rows[0].any)return;
   const changed=(await db.client.query({text:`WITH current AS (${selection}) SELECT EXISTS((SELECT * FROM current EXCEPT ALL SELECT * FROM ${links}) UNION ALL (SELECT * FROM ${links} EXCEPT ALL SELECT * FROM current)) AS changed`,values:[[from,to]]})).rows[0].changed;
   if(changed)throw new StorageError('version-changed','Linked child references changed after saver preflight.');
   await each(async row=>{if(!row.snapshot)return;const snapshot=deserialize(row.snapshot),current=(await db.rows('BaseItems',{where:{Id:snapshot.Id},limit:1}))[0];if(!current||!isDeepStrictEqual(current,snapshot))throw new StorageError('version-changed','A linked parent changed after saver preflight.');});
   const targets=`SELECT ${sql.guidKey('"ParentId"')} FROM ${links} WHERE "ChildType"=0 AND ${sql.guidKey('"ChildId"')}=$2`;
   await db.client.query(`UPDATE ${table} SET "ChildId"=$3 WHERE "ChildType"=0 AND ${sql.guidKey('"ChildId"')}=$1 AND ${sql.guidKey('"ParentId"')} NOT IN (${targets})`,[from,to,nativeTextBytes(toChildId)]);
   await db.client.query(`DELETE FROM ${table} WHERE "ChildType"=0 AND ${sql.guidKey('"ChildId"')}=$1 AND ${sql.guidKey('"ParentId"')} IN (${targets})`,[from,to]);
   await each(async row=>{if(!row.writable)return;await this.itemCreation.withItem(decodeNativeTextBytes(row.ParentId,'runtime'),async parent=>{if(!parent?.IsFolder)return;const loaded=await this.loadContext(parent.Id,{draft:parent,includeChildren:false});try{if(!row.snapshot||!isDeepStrictEqual(loaded.snapshot,deserialize(row.snapshot)))throw new StorageError('version-changed','A linked parent changed before its saver lifecycle.');for await(const page of this.itemCreation.linkedChildren.pages(parent.LinkedChildren)){for(const link of page)if(sameId(link.ItemId,fromChildId))await this.itemCreation.linkedChildren.recordResolution(parent.LinkedChildren,link.Ordinal,toChildId);}await this.updates.runMetadataSavers(loaded,ItemUpdateType.MetadataEdit);}finally{await loaded.dispose();}});});
   return;
  }finally{await db.client.query(`DROP TABLE IF EXISTS ${parents},${links}`);}
 });}
}
