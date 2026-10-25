import {quoteIdentifier as q} from '../database/model.js';
import {nativeTextBytes} from '../database/native-text.js';
import {nativeTextSql} from '../database/native-text-sql.js';
import {emptyLinkedChildrenPlan} from './postgres-linked-children.js';
const fields='"ItemId","Type","Path","LibraryItemId"';
const offset=(plan,size)=>plan.text.replace(/\$(\d+)\b/gu,(_,value)=>'$'+(Number(value)+size));
export function playlistStoredLinksPlan(database,id,{resolvedOnly=false,excludeChildIds=[]}={}){
 const sql=nativeTextSql(database.schemaName),links=`${q(database.schemaName)}.${q('LinkedChildren')}`,items=`${q(database.schemaName)}.${q('BaseItems')}`;
 const values=[nativeTextBytes(id)],where=[`${sql.guidKey('link."ParentId"')}=${sql.guidKey('$1::bytea')}`];
 if(resolvedOnly)where.push(`EXISTS(SELECT 1 FROM ${items} item WHERE ${sql.guidKey('item."Id"')}=${sql.guidKey('link."ChildId"')})`);
 if(excludeChildIds.length){values.push(excludeChildIds.map(String));where.push(`${sql.guidKey('link."ChildId"')}<>ALL($2::text[])`);}
 return {text:`SELECT row_number() OVER(ORDER BY link."SortOrder") AS "Ordinal",link."ChildId" AS "ItemId",link."ChildType"::integer AS "Type",NULL::bytea AS "Path",NULL::bytea AS "LibraryItemId"
   FROM ${links} link WHERE ${where.join(' AND ')} ORDER BY link."SortOrder"`,values};
}
export async function insertPlaylistLinks(store,current,additions,position){
 const left=store.plan(current),right=store.plan(additions),count=await store.count(current),index=position==null?count:BigInt(Math.max(0,Math.min(Number(count),Math.trunc(position))));
 const values=[...left.values,...right.values,index],parameter='$'+values.length;
 return store.createFromPlan({plan:{text:`WITH current AS (${left.text}),added AS (${offset(right,left.values.length)}),ordered AS (
  SELECT CASE WHEN "Ordinal"<=${parameter}::bigint THEN 0 ELSE 2 END AS section,"Ordinal",${fields} FROM current
  UNION ALL SELECT 1,"Ordinal",${fields} FROM added)
  SELECT row_number() OVER(ORDER BY section,"Ordinal") AS "Ordinal",${fields} FROM ordered ORDER BY section,"Ordinal"`,values}});
}
export const emptyPlaylistLinks=store=>store.createFromPlan({plan:emptyLinkedChildrenPlan()});
export async function movePlaylistLink(store,current,{movingOrdinal,insertionIndex}){
 const source=store.plan(current),values=[...source.values,movingOrdinal,insertionIndex],moving='$'+(values.length-1),index='$'+values.length;
 return store.createFromPlan({plan:{text:`WITH source AS (${source.text}),remaining AS (
   SELECT *,row_number() OVER(ORDER BY "Ordinal") AS position FROM source WHERE "Ordinal"<>${moving}::bigint),ordered AS (
   SELECT CASE WHEN position<=${index}::bigint THEN 0 ELSE 2 END AS section,position,${fields} FROM remaining
   UNION ALL SELECT 1,0::bigint,${fields} FROM source WHERE "Ordinal"=${moving}::bigint)
   SELECT row_number() OVER(ORDER BY section,position) AS "Ordinal",${fields} FROM ordered ORDER BY section,position`,values}});
}
