import {randomUUID} from 'node:crypto';
import {quoteIdentifier as q} from '../database/model.js';
import {nativeTextBytes,decodeNativeTextBytes} from '../database/native-text.js';
import {nativeTextSql} from '../database/native-text-sql.js';
import {beforeMetadataRefresh} from './before-refresh.js';
import {fillMissingEpisodeNumbersFromPath} from './episode-naming.js';
import {ItemUpdateType} from './save-manager.js';
import {EMPTY_ID,sameId,idKey} from '../library/records.js';
import {nativeDirectoryName} from '../library/native-path.js';
const type=(sql,value)=>sql.fromProjection(`'${value}'`);
const consume=async(sequence,operation)=>{for await(const page of sequence.pages())for(const item of page)await operation(item);};
async function selected(sequence,predicate,operation){
 return sequence.aggregationSession(async(database,{plan})=>{const table=q('mm_tv_selected_'+randomUUID().replaceAll('-','')),sql=nativeTextSql(database.schemaName);
  try{await database.client.query({text:`CREATE TEMP TABLE ${table} AS WITH rows AS (${plan.text}) SELECT item."Ordinal" FROM rows item WHERE ${predicate(sql)}`,values:plan.values});
   let ordinal=0n;for await(const page of sequence.pages()){const start=ordinal+1n,end=ordinal+BigInt(page.length),rows=(await database.client.query(`SELECT "Ordinal" FROM ${table} WHERE "Ordinal">=$1 AND "Ordinal"<=$2`,[start,end])).rows,selectedOrdinals=new Set(rows.map(row=>BigInt(row.Ordinal)));
    for(const item of page){if(selectedOrdinals.has(++ordinal))await operation(item);}
   }
  }finally{await database.client.query(`DROP TABLE IF EXISTS ${table}`);}
 });
}

export async function beforeSeriesMetadataRefresh(series,options,lifecycle){const state=await lifecycle.load(series);try{const recursive=await state.recursive();await consume(recursive,async season=>{if(season.Type==='Season'&&beforeMetadataRefresh(season,await state.contextFor(season)))await lifecycle.update(season,ItemUpdateType.MetadataEdit,options.signal);});}finally{await state.close();}}

export async function afterSeriesMetadataRefresh(series,options,lifecycle){let state=await lifecycle.load(series);const reload=async()=>{await state.close();state=await lifecycle.load(series);};
 try{
  if(state.libraryOptions.EnableAutomaticSeriesGrouping){const children=await state.recursive();await consume(children,async child=>{
   if(!['Season','Episode'].includes(child.Type))return;let update=ItemUpdateType.None;
   if((child.SeriesPresentationUniqueKey??null)!==state.presentationUniqueKey){child.SeriesPresentationUniqueKey=state.presentationUniqueKey;update|=ItemUpdateType.MetadataImport;}
   if(child.Type==='Episode'){const season=await state.findSeason(child);if(season&&!sameId(child.SeasonId??EMPTY_ID,season.Id)){child.SeasonId=season.Id;update|=ItemUpdateType.MetadataImport;}}
   if(update>ItemUpdateType.None)await lifecycle.update(child,update,options.signal);
  });await reload();}
  const episodes=await state.seriesEpisodes();await selected(episodes,sql=>`(item."IsVirtualItem" OR item."LocationType"=${type(sql,'Virtual')}) AND (item."IndexNumber" IS NULL OR EXISTS(SELECT 1 FROM rows physical WHERE NOT physical."IsVirtualItem" AND physical."LocationType" IS DISTINCT FROM ${type(sql,'Virtual')} AND physical."ParentIndexNumber" IS NOT DISTINCT FROM item."ParentIndexNumber" AND physical."IndexNumber" IS NOT NULL AND (CASE WHEN physical."IndexNumberEnd" IS NOT NULL THEN item."IndexNumber" BETWEEN physical."IndexNumber" AND physical."IndexNumberEnd" ELSE item."IndexNumber"=physical."IndexNumber" END)))`,episode=>lifecycle.remove(episode));
  await reload();const directSeasons=await state.children();await selected(directSeasons,sql=>`item."ItemType"=${type(sql,'Season')} AND item."LocationType"=${type(sql,'Virtual')}`,async season=>{
   const duplicate=await directSeasons.aggregationSession(async(database,{plan})=>(await database.client.query({text:`WITH rows AS (${plan.text}) SELECT EXISTS(SELECT 1 FROM rows WHERE "ItemType"=$1 AND "LocationType" IS DISTINCT FROM $2 AND "IndexNumber"=$3) AS present`,values:[nativeTextBytes('Season'),nativeTextBytes('Virtual'),season.IndexNumber??null]})).rows[0].present);
   if(duplicate||await(await state.seasonEpisodes(season)).count()===0n)await lifecycle.remove(season);
  });
  await reload();const recursive=await state.recursive();await consume(recursive,async episode=>{if(episode.Type==='Episode'&&episode.ParentIndexNumber==null)try{fillMissingEpisodeNumbersFromPath(episode,await state.contextFor(episode),false);}catch(error){lifecycle.logger?.error(error,`Error resolving season number from path for ${episode.Path}`);}});
  await recursive.aggregationSession(async(database,{plan})=>{
   const sql=nativeTextSql(database.schemaName),seasons=q('mm_tv_seasons_'+randomUUID().replaceAll('-','')),required=q('mm_tv_required_'+randomUUID().replaceAll('-',''));
   try{
    await database.client.query({text:`CREATE TEMP TABLE ${seasons} AS SELECT * FROM (${plan.text}) rows WHERE "ItemType"=$1`,values:[nativeTextBytes('Season')]});
    await database.client.query(`CREATE TEMP TABLE ${required}("Ordinal" bigint PRIMARY KEY,"Number" integer)`);
    let ordinal=0n;for await(const page of recursive.pages())for(const episode of page){++ordinal;if(episode.Type!=='Episode')continue;let include=episode.ParentIndexNumber!=null;
     if(!include){const row=(await database.client.query(`SELECT NOT EXISTS(SELECT 1 FROM ${seasons} WHERE "LocationType" IS DISTINCT FROM $1 AND (${sql.guidKey('"Id"')}=$2 OR ${sql.ordinalIgnoreCaseKey('"Path"')}=${sql.ordinalIgnoreCaseKey('$3::bytea')})) AS include`,[nativeTextBytes('Virtual'),idKey(episode.SeasonId),nativeTextBytes(nativeDirectoryName(episode.Path)??'')])).rows[0];include=row.include;}
     if(include)await database.client.query(`INSERT INTO ${required} VALUES($1,$2)`,[ordinal,episode.ParentIndexNumber>=0?episode.ParentIndexNumber??null:null]);
    }
    for(let after=0n;;){const numbers=(await database.client.query(`SELECT min("Ordinal") AS first,"Number" FROM ${required} GROUP BY "Number" HAVING min("Ordinal")>$1 ORDER BY first LIMIT 128`,[after])).rows;if(!numbers.length)break;
     for(const row of numbers){const number=row.Number,existing=(await database.client.query(`SELECT * FROM ${seasons} WHERE "IndexNumber" IS NOT DISTINCT FROM $1 ORDER BY "Ordinal" LIMIT 1`,[number])).rows[0];
      if(!existing){const season=await lifecycle.createSeason(series,number,state,options.signal),position=BigInt((await database.client.query(`SELECT COALESCE(max("Ordinal"),0)+1 AS next FROM ${seasons}`)).rows[0].next);await database.client.query(`INSERT INTO ${seasons}("Ordinal","Id","Name","IndexNumber","ItemType","LocationType","IsVirtualItem") VALUES($1,$2,$3,$4,$5,$6,$7)`,[position,nativeTextBytes(season.Id),season.Name==null?null:nativeTextBytes(season.Name),season.IndexNumber??null,nativeTextBytes('Season'),nativeTextBytes(season.LocationType),season.IsVirtualItem]);
      }else if(existing.IsVirtualItem){const physical=(await database.client.query({text:`SELECT EXISTS(SELECT 1 FROM (${plan.text}) rows WHERE "ItemType"=$1 AND "ParentIndexNumber" IS NOT DISTINCT FROM $2 AND "LocationType" IS DISTINCT FROM $3) AS present`,values:[nativeTextBytes('Episode'),number,nativeTextBytes('Virtual')]})).rows[0].present;if(physical){await selected(recursive,sql=>`item."Id"=${sql.fromProjection("'"+decodeNativeTextBytes(existing.Id,'runtime').replaceAll("'","''")+"'")}`,async season=>{season.IsVirtualItem=false;await lifecycle.update(season,ItemUpdateType.MetadataEdit,options.signal);});await database.client.query(`UPDATE ${seasons} SET "IsVirtualItem"=FALSE WHERE "Ordinal"=$1`,[existing.Ordinal]);}}
     }after=BigInt(numbers.at(-1).first);
    }
    await consume(recursive,async episode=>{if(episode.Type!=='Episode')return;const season=(await database.client.query(`SELECT "Id","Name" FROM ${seasons} WHERE "IndexNumber" IS NOT DISTINCT FROM $1 ORDER BY "Ordinal" LIMIT 1`,[episode.ParentIndexNumber??null])).rows[0];if(!season)return;const seasonId=decodeNativeTextBytes(season.Id,'runtime');if(sameId(episode.SeasonId??EMPTY_ID,seasonId))return;episode.SeasonId=seasonId;episode.SeasonName=season.Name==null?null:decodeNativeTextBytes(season.Name,'runtime');await lifecycle.update(episode,ItemUpdateType.MetadataImport,options.signal);});
   }finally{await database.client.query(`DROP TABLE IF EXISTS ${required},${seasons}`);}
  });
 }finally{await state.close();}
}
