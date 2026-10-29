import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';
import { dateTicks } from './records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeFileSystemPathKey } from './root-folder-file-data.js';
import { captureNativeItemState, restoreNativeItemState, restoreEvictedNativeItemLinks, observeNativeItemState,
  acquireNativeItemLinkOwner, isNativeItemEntity } from './native-item-entity.js';
import { EMPTY_NATIVE_LINKS, isLinkedChildrenHandle } from './postgres-linked-children.js';

const encode = value => value == null ? null : nativeTextBytes(value);
const aggregateType = 'MediaBrowser.Controller.Entities.AggregateFolder';
const stateCacheLimit = 128;
function cacheState(entry, slot, bytes) {
  entry.stateCache.delete(slot);
  entry.stateCache.set(slot, bytes);
  if (entry.stateCache.size > stateCacheLimit) entry.stateCache.delete(entry.stateCache.keys().next().value);
}
async function readState(entry, session, slot) {
  const cached = entry.stateCache.get(slot);
  if (cached !== undefined) { cacheState(entry, slot, cached); return cached; }
  const bytes = (await session.client.query({ name: entry.statementPrefix + '_read',
    text: `SELECT state FROM ${entry.states} WHERE scope_id=$1 AND slot_id=$2`, values: [entry.id, slot] })).rows[0]?.state;
  if (bytes !== undefined) cacheState(entry, slot, bytes);
  return bytes;
}
function serializableState(state) {
  if (state.values.NativeType !== aggregateType) return state;
  // VirtualChildren is a host-owned entity graph. Its Folder members can own
  // SQL handles, so it cannot be copied into a scalar slot snapshot. Consumers
  // of that graph borrow the admitted Aggregate source through resolveSourceSlot.
  const values = { ...state.values };
  delete values.VirtualChildren;
  return { ...state, values };
}
function plain(value, seen = new Map()) {
  if(value===null||typeof value!=='object')return value;
  if(seen.has(value))return seen.get(value);
  if(ArrayBuffer.isView(value))return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  if(value instanceof Date)return new Date(value);
  if(value instanceof Map){const result=new Map();seen.set(value,result);for(const[k,v]of value)result.set(plain(k,seen),plain(v,seen));return result;}
  if(value instanceof Set){const result=new Set();seen.set(value,result);for(const v of value)result.add(plain(v,seen));return result;}
  const result=Array.isArray(value)?[]:{};seen.set(value,result);for(const[k,v]of Object.entries(value))Object.defineProperty(result,k,{value:plain(v,seen),enumerable:true,writable:true,configurable:true});return result;
}
function active(view) { if(view.released)throw new Error('The typed item cohort has been released.'); }
function materialized(entry, item, slot) {
  const result = entry.onMaterialize?.(item, slot);
  if (result && typeof result.then === 'function') throw new TypeError('A typed materialization hook must complete synchronously.');
}
function enqueue(entry, operation) {
  const pending=entry.tail.then(()=>entry.scope.run(operation));
  entry.tail=pending.catch(error=>{if(!entry.errorPresent){entry.error=error;entry.errorPresent=true;}});return pending;
}
async function flush(entry) { await entry.tail;if(entry.errorPresent)throw entry.error; }
function stateValues(entry,slot,state) {
  // Null means the native All predicate would throw when it is evaluated.
  // Capture itself must not run a later Guide consumer's failure early.
  let allLocalOrSd = true;
  if (!Array.isArray(state.values.ImageInfos)) allLocalOrSd = null;
  else for (const image of state.values.ImageInfos) {
    if (typeof image?.Path !== 'string') { allLocalOrSd = null; break; }
    const path = ordinalIgnoreCaseKey(image.Path);
    if (path.startsWith('HTTP') && !path.includes('SCHEDULESDIRECT')) { allLocalOrSd = false; break; }
  }
  const type = state.values.NativeType.split('.').at(-1);
  const locations = ['AggregateFolder', 'CollectionFolder'].includes(type) ? state.values.PhysicalLocationsList
    : state.values.Path ? [state.values.Path] : [];
  return [entry.id,slot,serialize(plain(serializableState(state))),encode(state.values.Id),encode(state.values.OfficialRating),encode(state.values.CustomRating),encode(state.sorting.name),
    state.values.EndDate == null ? null : dateTicks(state.values.EndDate), allLocalOrSd,encode(state.values.Path),encode(state.values.NativeType),
    locations == null ? null : locations.map(encode), encode(state.values.PreferredMetadataCountryCode),
    state.values.Tags == null ? null : state.values.Tags.map(encode), encode(nativeFileSystemPathKey(state.values.Path))];
}
async function writeStates(entry,session,rows) {
  if (!rows.length) return;
  const values = rows.flat(), placeholders = rows.map((row,index) => '(' + row.map((_value,field) => '$' + (index * row.length + field + 1)).join(',') + ')');
  try { await session.client.query({ name: entry.statementPrefix + '_write_' + rows.length,
    text: `INSERT INTO ${entry.states}(scope_id,slot_id,state,"Id","OfficialRating","CustomRating","Name","EndDateTicks","AllImagesLocalOrSd","Path","NativeType","PhysicalLocations","PreferredCountry","Tags","FileSystemPathKey")
    VALUES ${placeholders.join(',')} ON CONFLICT(scope_id,slot_id) DO UPDATE SET state=EXCLUDED.state,"Id"=EXCLUDED."Id",
    "OfficialRating"=EXCLUDED."OfficialRating","CustomRating"=EXCLUDED."CustomRating","Name"=EXCLUDED."Name",
    "EndDateTicks"=EXCLUDED."EndDateTicks","AllImagesLocalOrSd"=EXCLUDED."AllImagesLocalOrSd","Path"=EXCLUDED."Path","NativeType"=EXCLUDED."NativeType",
    "PhysicalLocations"=EXCLUDED."PhysicalLocations","PreferredCountry"=EXCLUDED."PreferredCountry","Tags"=EXCLUDED."Tags","FileSystemPathKey"=EXCLUDED."FileSystemPathKey"`,
    values }); }
  catch (error) {
    // A rejected dispatch may already have reached PostgreSQL. The next
    // queued mutation must read its actual row instead of an older receipt.
    for (const row of rows) entry.stateCache.delete(row[1]);
    throw error;
  }
  for (const row of rows) cacheState(entry, row[1], row[2]);
}
function observe(entry,item,slot) {
  const reference=new WeakRef(entry);
  observeNativeItemState(item,(_item,field,value,deleted)=>{
    const current=reference.deref();if(!current||current.references===0)return;
    current.revision++;
    // The source owner observes this live graph; serializing its SQL resource
    // branches would re-enter the database driver through a nested Folder.
    if (_item.NativeType === aggregateType && field === 'VirtualChildren') return;
    const link=field==='LinkedChildren'&&isLinkedChildrenHandle(value)?value.retain():null;
    const captured=field==='LinkedChildren'?value===null?null:value===EMPTY_NATIVE_LINKS?EMPTY_NATIVE_LINKS:link:plain(value);
    enqueue(current,async session=>{
      try {
        // This bounded cache contains only this serial queue's acknowledged
        // SQL bytes. Complete slot storage and every candidate plan stay in
        // PostgreSQL; eviction always falls back to its actual row.
        const previous=await readState(current,session,slot);
        if(previous===undefined)return;
        const state=deserialize(previous);
        if(field==='LinkedChildren')state.folder={loaded:true,kind:captured===null?'null':captured===EMPTY_NATIVE_LINKS?'empty':'relation',
          token:link?await current.links.pinState(link,{session,scopeId:current.id,slotId:slot}):null};
        else if(['Name','ForcedSortName','SortName'].includes(field)) {
          const name=field==='Name'?'name':field==='ForcedSortName'?'forcedSortName':'sortName';state.sorting[name]=captured;
          if(field!=='SortName')state.sorting.sortName=null;
        } else if(field==='NativeRepositoryColumns')state.repositoryColumns=captured;
        else if(deleted){delete state.values[field];delete state.hiddenValues[field];}
        else if(Object.hasOwn(state.hiddenValues,field))state.hiddenValues[field]=captured;
        else Object.defineProperty(state.values,field,{value:captured,enumerable:true,writable:true,configurable:true});
        if(field==='DateLastSaved')state.date={value:captured,json:null};
        const row=stateValues(current,slot,state);
        if(!row[2].equals(previous))await writeStates(current,session,[row]);
      } finally { if(link)await current.links.release(link,{session}); }
    }).catch(()=>{});
  });
}
class NativeItemCohort {
  constructor(entry,id=entry.id) {this.entry=entry;this.id=id;this.released=false;entry.references++;}
  retain(){active(this);return new NativeItemCohort(this.entry,this.id);}
  async flush(){active(this);await flush(this.entry);}
  /** One SQL row per exact captured entity slot, regardless of request repeats. */
  plan(){active(this);return Object.freeze({text:`SELECT slot_id AS "SlotKey","OfficialRating","CustomRating","Name" FROM ${this.entry.states} WHERE scope_id=$1`,values:Object.freeze([this.entry.id])});}
  /** Ordered occurrences and their current identity remain a SQL relation.
   * Consumers can select final per-ID winners without hydrating every item. */
  orderedPlan(){active(this);return Object.freeze({text:`SELECT cohort."Ordinal",cohort.slot_id AS "SlotKey",state."Id"
    FROM ${this.entry.rows} cohort JOIN ${this.entry.states} state ON state.scope_id=cohort.scope_id AND state.slot_id=cohort.slot_id
    WHERE cohort.view_id=$1`,values:Object.freeze([this.id])});}
  /** Directory consumers select the first exact cached occurrence in SQL. */
  pathPlan(){active(this);return Object.freeze({text:`SELECT cohort."Ordinal",cohort.slot_id AS "SlotKey",state."Id",state."Path",state."NativeType",state."PhysicalLocations",state."PreferredCountry",state."Tags",state."FileSystemPathKey"
    FROM ${this.entry.rows} cohort JOIN ${this.entry.states} state ON state.scope_id=cohort.scope_id AND state.slot_id=cohort.slot_id
    WHERE cohort.view_id=$1`,values:Object.freeze([this.id])});}
  /** Guide filtering inspects these live scalar projections in SQL. Invalid
   * image paths stay candidates so the native predicate fails at consumption. */
  guideImagePlan(){active(this);return Object.freeze({text:`SELECT cohort."Ordinal",cohort.slot_id AS "SlotKey",state."Id",state."EndDateTicks",state."AllImagesLocalOrSd"
    FROM ${this.entry.rows} cohort JOIN ${this.entry.states} state ON state.scope_id=cohort.scope_id AND state.slot_id=cohort.slot_id
    WHERE cohort.view_id=$1`,values:Object.freeze([this.id])});}
  async captureSlot(item) {
    return (await this.captureSlots([item]))[0];
  }
  async captureSlots(items) {
    active(this);
    if (!Array.isArray(items) || items.length > 128) throw new TypeError('Typed capture pages require at most 128 items.');
    const retained = this.retain(), entry = this.entry, owners = [], captured = [], slots = [];
    let invalid, failure, failed=false;
    try {
      await enqueue(entry, async session => {
        const rows = new Map();
        let primary, primaryFailed=false;
        try {
          for (const item of items) {
            if (!isNativeItemEntity(item)) { invalid = new TypeError('An exact native item is required.'); break; }
            let slot = entry.slots.get(item);
            const first = !slot;
            if (first) { slot = randomUUID(); entry.slots.set(item,slot); }
            owners.push(acquireNativeItemLinkOwner(item));
            const state = await captureNativeItemState(item,{linkedChildren:entry.links,session,scopeId:entry.id,slotId:slot});
            // Freeze each snapshot before the next item's asynchronous pin.
            rows.set(slot,stateValues(entry,slot,state)); slots.push(slot); captured.push({item,slot});
            if (first) observe(entry,item,slot);
          }
        } catch (error) { primary = error; primaryFailed=true; }
        try { await writeStates(entry,session,[...rows.values()]); }
        catch (error) { throw primaryFailed ? new AggregateError([primary,error],primary?.message??'Typed state capture failed.',{cause:primary}) : error; }
        if (primaryFailed) throw primary;
      });
      for (const {item,slot} of captured) materialized(entry,item,slot);
      if (invalid) throw invalid;
      return slots;
    } catch (error) { failure = error; failed=true; throw error; }
    finally {
      const errors = [];
      for (const cleanup of [...owners.map(owner => () => owner.release()), () => entry.links.flushReleases(), () => retained.release()]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(failed ? [failure,...errors] : errors,
        failure?.message ?? 'Typed capture ownership cleanup failed.',failed ? {cause:failure} : undefined);
    }
  }
  async appendSlot(slot,{ordinal}={}) {
    active(this);if(typeof slot!=='string'||typeof ordinal!=='bigint'||ordinal<=0n)throw new TypeError('An owned slot and positive bigint ordinal are required.');
    const entry=this.entry;
    await enqueue(entry,async session=>{
      const result=await session.client.query({name:entry.statementPrefix+'_append',text:`INSERT INTO ${entry.rows}(view_id,"Ordinal",scope_id,slot_id)
        SELECT $1,$2,scope_id,slot_id FROM ${entry.states} WHERE scope_id=$3 AND slot_id=$4
        ON CONFLICT(view_id,"Ordinal") DO UPDATE SET scope_id=EXCLUDED.scope_id,slot_id=EXCLUDED.slot_id`,values:[this.id,ordinal,entry.id,slot]});
      if(result.rowCount!==1)throw new TypeError('The slot belongs to a different or released cohort.');
    });
    return slot;
  }
  async capture(item,{ordinal}={}) {
    if(typeof ordinal!=='bigint'||ordinal<=0n)throw new TypeError('A positive bigint ordinal is required.');
    return this.appendSlot(await this.captureSlot(item),{ordinal});
  }
  /** Copy the TEMP selection on its own autocommitted session before disposal.
   * Only the selection is copied; all retained views share the captured slots. */
  async view({session,plan}) {
    active(this);await flush(this.entry);
    if(!session?.connectionSession||session.inTransaction||typeof plan?.text!=='string'||!Array.isArray(plan.values))throw new TypeError('A checked-out nontransaction selection session is required.');
    const id=randomUUID(),offset=plan.values.length;
    await session.client.query({text:`INSERT INTO ${this.entry.rows}(view_id,"Ordinal",scope_id,slot_id)
      SELECT $${offset+1},source."Ordinal",$${offset+2},source."SlotKey" FROM (${plan.text}) source
      JOIN ${this.entry.states} state ON state.scope_id=$${offset+2} AND state.slot_id=source."SlotKey" ORDER BY source."Ordinal"`,values:[...plan.values,id,this.entry.id]});
    return new NativeItemCohort(this.entry,id);
  }
  async count(){active(this);await flush(this.entry);return this.entry.scope.run(async session=>BigInt((await session.client.query(`SELECT count(*) AS count FROM ${this.entry.rows} WHERE view_id=$1`,[this.id])).rows[0].count));}
  /** Read a captured slot at its consumption boundary, including observations
   * made by earlier callbacks. This never reloads the native repository row. */
  async withSlot(slot, operation) {
    active(this);
    if (typeof slot !== 'string' || typeof operation !== 'function') throw new TypeError('An owned slot and callback are required.');
    const retained = this.retain(), entry = this.entry;
    let owner, failure, failed=false;
    try {
      await flush(entry);
      const source = await entry.resolveSourceSlot?.(slot);
      if (source != null && typeof source !== 'function') throw new TypeError('A captured slot source must supply a borrowing callback.');
      if (source) return await source(async item => {
        const captured = entry.slots.get(item) === slot;
        owner = acquireNativeItemLinkOwner(item);
        materialized(entry,item,slot);
        entry.slots.set(item, slot);
        if (!captured) observe(entry, item, slot);
        return operation(item);
      });
      const item = await entry.scope.run(async session => {
        const row = (await session.client.query({ name: entry.statementPrefix + '_read',
          text: `SELECT state FROM ${entry.states} WHERE scope_id=$1 AND slot_id=$2`, values: [entry.id, slot] })).rows[0];
        if (!row) throw new TypeError('The slot belongs to a different or released cohort.');
        const state = deserialize(row.state), live = entry.resolveLiveItem?.(state.values.Id, slot);
        const reused = live && entry.slots.get(live) === slot;
        const value = reused ? live : await restoreNativeItemState(state, {}, { linkedChildren: entry.links, session });
        if (reused) await restoreEvictedNativeItemLinks(value, state, { linkedChildren: entry.links, session });
        owner = acquireNativeItemLinkOwner(value);
        materialized(entry,value,slot);
        entry.slots.set(value, slot);
        if (!reused) observe(entry, value, slot);
        return value;
      });
      return await operation(item);
    } catch (error) { failure = error; failed=true; throw error; }
    finally {
      const errors = [];
      for (const cleanup of [() => owner?.release(), () => entry.links.flushReleases(), () => retained.release()]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors,
        failure?.message ?? 'Typed slot ownership cleanup failed.', failed ? { cause: failure } : undefined);
    }
  }
  async withSlots(slots, operation) {
    active(this);
    if (!Array.isArray(slots) || slots.length > 128 || typeof operation !== 'function') throw new TypeError('Typed slot pages require at most 128 slots and a callback.');
    const retained = this.retain(), entry = this.entry, owners = [];
    let failure, failed=false;
    try {
      await flush(entry);
      const revision = entry.revision;
      const rows = slots.length ? await entry.scope.run(async session => (await session.client.query(
        `SELECT slot_id,state FROM ${entry.states} WHERE scope_id=$1 AND slot_id::text=ANY($2::text[])`,
        [entry.id,slots.filter(slot => typeof slot === 'string')])).rows) : [];
      const states = new Map(rows.map(row => [row.slot_id,row.state])), results = [];
      for (const slot of slots) {
        if (typeof slot !== 'string') throw new TypeError('An owned slot and callback are required.');
        await flush(entry);
        const source = await entry.resolveSourceSlot?.(slot);
        if (source != null && typeof source !== 'function') throw new TypeError('A captured slot source must supply a borrowing callback.');
        if (source) {
          results.push(await source(async item => {
            const captured = entry.slots.get(item) === slot;
            owners.push(acquireNativeItemLinkOwner(item));
            materialized(entry,item,slot);
            entry.slots.set(item,slot);
            if (!captured) observe(entry,item,slot);
            return operation(item,slot);
          }));
          continue;
        }
        const item = await entry.scope.run(async session => {
          // A preceding callback may mutate this or another captured item.
          // Read its current SQL state instead of an earlier page snapshot.
          const bytes = entry.revision === revision && states.has(slot) ? states.get(slot)
            : (await session.client.query(`SELECT state FROM ${entry.states} WHERE scope_id=$1 AND slot_id=$2`,[entry.id,slot])).rows[0]?.state;
          if (!bytes) throw new TypeError('The slot belongs to a different or released cohort.');
          const state = deserialize(bytes), live = entry.resolveLiveItem?.(state.values.Id,slot);
          const reused = live && entry.slots.get(live) === slot;
          const value = reused ? live : await restoreNativeItemState(state,{}, {linkedChildren:entry.links,session});
          if (reused) await restoreEvictedNativeItemLinks(value,state,{linkedChildren:entry.links,session});
          owners.push(acquireNativeItemLinkOwner(value));
          materialized(entry,value,slot);
          entry.slots.set(value,slot);
          if (!reused) observe(entry,value,slot);
          return value;
        });
        results.push(await operation(item,slot));
      }
      return results;
    } catch (error) { failure = error; failed=true; throw error; }
    finally {
      const errors = [];
      for (const cleanup of [...owners.map(owner => () => owner.release()), () => entry.links.flushReleases(), () => retained.release()]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(failed ? [failure,...errors] : errors,
        failure?.message ?? 'Typed slot page ownership cleanup failed.',failed ? {cause:failure} : undefined);
    }
  }
  async page({after=0n,limit=128}={}) {
    active(this);if(typeof after!=='bigint'||after<0n||!Number.isInteger(limit)||limit<1||limit>128)throw new TypeError('Typed pages require a bigint cursor and limit from 1 to 128.');
    const retained=this.retain(),entry=this.entry,owners=[];
    let releasing;
    const release = (primary,failed=false) => releasing ??= (async()=>{
      const errors=[];
      for(const cleanup of [...owners.map(owner=>()=>owner.release()),()=>entry.links.flushReleases(),()=>retained.release()]){
        try{await cleanup();}catch(error){errors.push(error);}
      }
      if(errors.length)throw new AggregateError(failed?[primary,...errors]:errors,
        primary?.message??'Typed page ownership cleanup failed.',failed?{cause:primary}:undefined);
    })();
    try {
      await flush(entry);
      const items=new Map(),entries=[];
      const rows=await entry.scope.run(async session=>(await session.client.query(`SELECT cohort."Ordinal",cohort.slot_id,state.state FROM ${entry.rows} cohort
        JOIN ${entry.states} state ON state.scope_id=cohort.scope_id AND state.slot_id=cohort.slot_id
        WHERE cohort.view_id=$1 AND cohort."Ordinal">$2 ORDER BY cohort."Ordinal" LIMIT $3`,[this.id,after,limit])).rows);
      for(const row of rows){
        let item=items.get(row.slot_id);
        if(!item){
          const source=await entry.resolveSourceSlot?.(row.slot_id);
          if(source!=null&&typeof source!=='function')throw new TypeError('A captured slot source must supply a borrowing callback.');
          if(source) {
            await source(value=>{
              const captured=entry.slots.get(value)===row.slot_id;
              owners.push(acquireNativeItemLinkOwner(value));
              materialized(entry,value,row.slot_id);
              item=value;
              entry.slots.set(value,row.slot_id);if(!captured)observe(entry,value,row.slot_id);
            });
            items.set(row.slot_id,item);
            entries.push({Ordinal:BigInt(row.Ordinal),item});continue;
          }
          const state=deserialize(row.state),live=entry.resolveLiveItem?.(state.values.Id,row.slot_id);
          const reused=live&&entry.slots.get(live)===row.slot_id;
          item=await entry.scope.run(async session=>{
            const value=reused?live:await restoreNativeItemState(state,{}, {linkedChildren:entry.links,session});
            if(reused)await restoreEvictedNativeItemLinks(value,state,{linkedChildren:entry.links,session});
            return value;
          });
          owners.push(acquireNativeItemLinkOwner(item));
          materialized(entry,item,row.slot_id);
          items.set(row.slot_id,item);entry.slots.set(item,row.slot_id);
          if(!reused)observe(entry,item,row.slot_id);
        }
        entries.push({Ordinal:BigInt(row.Ordinal),item});
      }
      return Object.freeze({entries,release:()=>release()});
    } catch(error){await release(error,true);throw error;}
  }
  async release(){
    if(this.released)return;this.released=true;
    const entry=this.entry;if(--entry.references)return;
    const failures=[];
    try{await entry.tail;}catch(error){failures.push(error);}
    try{await entry.scope.run(async session=>{
      // Retained pages share this entry. External warm owners must outlive
      // those pages and release while the last admitted SQL scope still runs.
      for(const release of [()=>entry.onRelease?.({session}),
        ()=>session.client.query(`DELETE FROM ${entry.rows} WHERE scope_id=$1`,[entry.id]),
        ()=>session.client.query(`DELETE FROM ${entry.states} WHERE scope_id=$1`,[entry.id]),
        ()=>entry.links.releaseStateScope(entry.id,{session}),()=>entry.links.flushReleases({session})]){
        try{await release();}catch(error){failures.push(error);}
      }
    });}catch(error){failures.push(error);}finally{entry.stateCache.clear();try{entry.scope.release();}catch(error){failures.push(error);}}
    if(failures.length)throw new AggregateError(failures,'Typed cohort release failed.');
  }
}
export async function createNativeItemCohort({linkedChildren,resolveLiveItem,resolveSourceSlot,onRelease,onMaterialize}) {
  if(resolveLiveItem!==undefined&&typeof resolveLiveItem!=='function')throw new TypeError('A live slot resolver must be a function.');
  if(onRelease!==undefined&&typeof onRelease!=='function')throw new TypeError('A cohort release hook must be a function.');
  if(resolveSourceSlot!==undefined&&typeof resolveSourceSlot!=='function')throw new TypeError('A captured slot source resolver must be a function.');
  if(onMaterialize!==undefined&&typeof onMaterialize!=='function')throw new TypeError('A synchronous materialization hook is required.');
  // Reuse only the SQL definition on each physical connection. The runtime
  // table identity prevents collisions across repositories; write arity keeps
  // every bounded VALUES shape distinct. All executions bind their live values.
  const entry={id:randomUUID(),links:linkedChildren,resolveLiveItem,resolveSourceSlot,onRelease,onMaterialize,scope:linkedChildren.admitScope(),slots:new WeakMap(),stateCache:new Map(),tail:Promise.resolve(),references:0,error:null,errorPresent:false,revision:0,
    statementPrefix:'mm_cohort_'+linkedChildren.schemaName,
    states:`${q(linkedChildren.schemaName)}.item_states`,rows:`${q(linkedChildren.schemaName)}.item_cohorts`};
  return new NativeItemCohort(entry);
}
