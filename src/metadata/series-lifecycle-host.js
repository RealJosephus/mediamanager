import { saveMetadataItem } from './save-item.js';
import { metadataSortName } from './sort-cache.js';
import { tableDefinition } from '../database/model.js';
import { EMPTY_ID, MIN_DATE, cleanValue, guid, idKey, mapRecord, nonemptyId } from '../library/records.js';
import { createMetadataChildren } from '../library/metadata-children.js';
import { resolveSeries } from '../library/series-reference.js';
import { deletePersistedItems } from '../library/item-persistence.js';
import { persistItemRelations } from '../library/item-relations.js';
import { createPresentationUniqueKey } from '../library/presentation-key.js';
import { formatComposite } from '../core/composite-format.js';
import {acquireNativeItemLinkOwner} from '../library/native-item-entity.js';
import {nativeTextSql} from '../database/native-text-sql.js';
import {ItemDeletionScope} from '../library/item-deletion-scope.js';

const emptyRow = () => Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

export class SeriesMetadataLifecycleHost {
  constructor({ store, loadContext, updates, externalData, refresh, itemCreation, logger, now }) {
    Object.assign(this, { store, loadContext, updates, externalData, refresh, itemCreation, logger, now });
  }

  async load(series) {
    const loaded=await this.loadContext(series.Id,{draft:series,includeChildren:false});
    const factory=createMetadataChildren({store:this.store,library:this.loadContext.library,linkedChildren:this.loadContext.linkedChildren,configuration:loaded.globalOptions,libraryOptions:loaded.libraryOptions});
    const sequences=new Set();let closed=false;
    const own=async promise=>{const sequence=await promise;sequences.add(sequence);return sequence;};
    const contextFor=item=>this.loadContext.withContext(item.Id,{draft:item,includeChildren:false},context=>({parent:context.parent,parents:context.parents,resolveSeries:context.resolveSeries,resolveSeason:context.resolveSeason}));
    return {...loaded,contextFor,async findSeason(item){const context=await contextFor(item),parent=context.parents.find(value=>value.Type==='Season');if(parent)return parent;
        const series=context.resolveSeries(item);if(!series||item.ParentIndexNumber==null)return null;
        const children=await own(factory.physical(series));for await(const page of children.pages())for(const child of page)if(child.Type==='Season'&&child.IndexNumber===item.ParentIndexNumber)return child;return null;},
      presentationUniqueKey:series.PresentationUniqueKey??createPresentationUniqueKey(series,loaded),
      children:()=>own(factory.physical(series)),recursive:()=>own(factory.recursive(series)),seriesEpisodes:()=>own(factory.seriesEpisodes(series)),seasonEpisodes:season=>own(factory.seasonEpisodes(season,{series})),
      async close(){if(closed)return;closed=true;const failures=[];for(const sequence of sequences)try{await sequence.close();}catch(error){failures.push(error);}try{await loaded.dispose();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'Series lifecycle state release failed.');}
    };
  }

  async update(item,reason,signal){return this.loadContext.withContext(item.Id,{draft:item,includeChildren:false},loaded=>saveMetadataItem(this.updates,loaded,{Item:item,People:null},reason,{signal}));}

  async remove(item){
    if(!['Episode','Season'].includes(item.Type))throw new TypeError('Obsolete TV cleanup requires an Episode or Season.');
    if(nonemptyId(item.PrimaryVersionId)||(item.LocalAlternateVersions??[]).length||(item.LinkedAlternateVersions??[]).length)throw Object.assign(new Error('Alternate-version deletion is not implemented.'),{status:501});
    return this.loadContext.withContext(item.Id,{draft:item,includeChildren:false},async loaded=>{
      const factory=createMetadataChildren({store:this.store,library:this.loadContext.library,linkedChildren:this.loadContext.linkedChildren,configuration:loaded.globalOptions,libraryOptions:loaded.libraryOptions});
      const children=await factory.recursive(item,{includeLinkedChildren:false}),parent=loaded.parent??null;
      try{await children.aggregationSession(async(database,{plan})=>{const scope=new ItemDeletionScope({store:this.store,database}),sql=nativeTextSql(database.schemaName),values=[...plan.values,idKey(item.Id)];
        const ids={text:`SELECT ${sql.guidKey('"Id"')} AS "Key" FROM (${plan.text}) children UNION SELECT $${values.length}::text`,values};
        try{await scope.capturePlan(ids);await this.externalData.deleteInternalItemFiles(item,{loaded});for await(const page of children.pages())for(const child of page)await this.externalData.deleteInternalItemFiles(child,{loaded});
        item.ParentId=EMPTY_ID;await this.externalData.deleteItemFiles(item,{loaded});for await(const page of children.pages())for(const child of page)await this.externalData.deleteItemFiles(child,{loaded});
        await scope.persistPlan(ids,{now:this.now,publishDeletedPage:page=>{for(const row of page)this.itemCreation?.unregisterItem(row.Key);}});
        for await(const page of children.pages())for(const child of page)this.updates.reportItemRemoved(child,item);this.updates.reportItemRemoved(item,parent);
        }finally{await scope.close();}
      });}finally{await children.close();}
    });
  }

  async createSeason(series, number, loaded, signal) {
    const name = number == null ? loaded.localizedText('NameSeasonUnknown') : number === 0 ? loaded.libraryOptions.SeasonZeroDisplayName
      : formatComposite(loaded.localizedText('NameSeasonNumber'), [number]);
    const nativeType = 'MediaBrowser.Controller.Entities.TV.Season';
    const Id = guid(loaded.getNewItemId(guid(series.Id) + String(number ?? -1) + (name ?? ''), nativeType));
    const date = this.now();
    const parents = [series, ...loaded.parents], collectionFolders = loaded.collectionFolders;
    const top=parents.find((item,index)=>['BasePluginFolder','Channel'].includes(item.Type)||item.CollectionType==='livetv'||parents[index+1]?.Type==='AggregateFolder');
    const row = { ...emptyRow(), Id, Type: nativeType, Name: name, IndexNumber: number, IsFolder: true, IsVirtualItem: false,
      ParentId: series.Id, SeriesId: series.Id, SeriesName: series.Name, SeriesPresentationUniqueKey: loaded.presentationUniqueKey,
      TopParentId: top?.Id ?? null, MediaType: 'Unknown', UnratedType: 'Series', DateCreated: date, DateModified: date,
      ChannelId: EMPTY_ID, Genres: '', Studios: '', Tags: '', ProductionLocations: '', Data: null };
    const season = mapRecord(row);
    season.ProviderIds = {}; season.LockedFields = [];
    season.DateLastRefreshed = season.DateLastSaved = MIN_DATE;
    // Native CreateItem maps the new entity immediately; it does not run the
    // metadata save host or stamp DateLastSaved until the subsequent refresh.
    row.CleanName = cleanValue(name);
    row.SortName = metadataSortName(season, loaded.libraryRuntimeOptions);
    await this.store.transaction(async db => {
      if ((await db.rows('BaseItems', { where: { Id } })).length) throw Object.assign(new Error('The new season identity is already in use.'), { status: 409 });
      await db.insert('BaseItems', row);
      await persistItemRelations(db, season, { parents, collectionFolders });
    });
    this.updates.reportItemAdded(season, series);
    await this.refresh(Id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true, signal });
    this.itemCreation?.registerItem(season);
    return this.itemCreation.getItemById(Id);
  }
}
