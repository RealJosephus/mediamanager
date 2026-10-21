import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';
import { dateTicks } from './records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { captureNativeItemState, restoreNativeItemState, observeNativeItemState,
  acquireNativeItemLinkOwner, isNativeItemEntity } from './native-item-entity.js';
import { EMPTY_NATIVE_LINKS, isLinkedChildrenHandle } from './postgres-linked-children.js';

const encode = value => value == null ? null : nativeTextBytes(value);
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
function enqueue(entry, operation) {
  const pending=entry.tail.then(()=>entry.scope.run(operation));
  entry.tail=pending.catch(error=>{entry.error??=error;});return pending;
}
async function flush(entry) { await entry.tail;if(entry.error)throw entry.error; }
async function writeState(entry,session,slot,state) {
  // Null means the native All predicate would throw when it is evaluated.
  // Capture itself must not run a later Guide consumer's failure early.
  let allLocalOrSd = true;
  if (!Array.isArray(state.values.ImageInfos)) allLocalOrSd = null;
  else for (const image of state.values.ImageInfos) {
    if (typeof image?.Path !== 'string') { allLocalOrSd = null; break; }
    const path = ordinalIgnoreCaseKey(image.Path);
    if (path.startsWith('HTTP') && !path.includes('SCHEDULESDIRECT')) { allLocalOrSd = false; break; }
  }
  await session.client.query(`INSERT INTO ${entry.states}(scope_id,slot_id,state,"Id","OfficialRating","CustomRating","Name","EndDateTicks","AllImagesLocalOrSd")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(scope_id,slot_id) DO UPDATE SET state=EXCLUDED.state,"Id"=EXCLUDED."Id",
    "OfficialRating"=EXCLUDED."OfficialRating","CustomRating"=EXCLUDED."CustomRating","Name"=EXCLUDED."Name",
    "EndDateTicks"=EXCLUDED."EndDateTicks","AllImagesLocalOrSd"=EXCLUDED."AllImagesLocalOrSd"`,
    [entry.id,slot,serialize(plain(state)),encode(state.values.Id),encode(state.values.OfficialRating),encode(state.values.CustomRating),encode(state.sorting.name),
      state.values.EndDate == null ? null : dateTicks(state.values.EndDate), allLocalOrSd]);
}
function observe(entry,item,slot) {
  const reference=new WeakRef(entry);
  observeNativeItemState(item,(_item,field,value,deleted)=>{
    const current=reference.deref();if(!current||current.references===0)return;
    const link=field==='LinkedChildren'&&isLinkedChildrenHandle(value)?value.retain():null;
    const captured=field==='LinkedChildren'?value===null?null:value===EMPTY_NATIVE_LINKS?EMPTY_NATIVE_LINKS:link:plain(value);
    enqueue(current,async session=>{
      try {
        const result=await session.client.query(`SELECT state FROM ${current.states} WHERE scope_id=$1 AND slot_id=$2`,[current.id,slot]);
        if(!result.rows.length)return;
        const state=deserialize(result.rows[0].state);
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
        await writeState(current,session,slot,state);
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
  /** Guide filtering inspects these live scalar projections in SQL. Invalid
   * image paths stay candidates so the native predicate fails at consumption. */
  guideImagePlan(){active(this);return Object.freeze({text:`SELECT cohort."Ordinal",cohort.slot_id AS "SlotKey",state."Id",state."EndDateTicks",state."AllImagesLocalOrSd"
    FROM ${this.entry.rows} cohort JOIN ${this.entry.states} state ON state.scope_id=cohort.scope_id AND state.slot_id=cohort.slot_id
    WHERE cohort.view_id=$1`,values:Object.freeze([this.id])});}
  async captureSlot(item) {
    active(this);if(!isNativeItemEntity(item))throw new TypeError('An exact native item is required.');
    const entry=this.entry;let slot=entry.slots.get(item);
    const first=!slot;if(first){slot=randomUUID();entry.slots.set(item,slot);}
    const owner=acquireNativeItemLinkOwner(item);
    try {
      await enqueue(entry,async session=>{
        const state=await captureNativeItemState(item,{linkedChildren:entry.links,session,scopeId:entry.id,slotId:slot});
        await writeState(entry,session,slot,state);
      });
      if(first)observe(entry,item,slot);return slot;
    } finally {owner.release();await entry.links.flushReleases();}
  }
  async appendSlot(slot,{ordinal}={}) {
    active(this);if(typeof slot!=='string'||typeof ordinal!=='bigint'||ordinal<=0n)throw new TypeError('An owned slot and positive bigint ordinal are required.');
    const entry=this.entry;
    await enqueue(entry,async session=>{
      const result=await session.client.query(`INSERT INTO ${entry.rows}(view_id,"Ordinal",scope_id,slot_id)
        SELECT $1,$2,scope_id,slot_id FROM ${entry.states} WHERE scope_id=$3 AND slot_id=$4
        ON CONFLICT(view_id,"Ordinal") DO UPDATE SET scope_id=EXCLUDED.scope_id,slot_id=EXCLUDED.slot_id`,[this.id,ordinal,entry.id,slot]);
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
    let owner, failure;
    try {
      await flush(entry);
      const item = await entry.scope.run(async session => {
        const row = (await session.client.query(`SELECT state FROM ${entry.states} WHERE scope_id=$1 AND slot_id=$2`, [entry.id, slot])).rows[0];
        if (!row) throw new TypeError('The slot belongs to a different or released cohort.');
        const state = deserialize(row.state), live = entry.resolveLiveItem?.(state.values.Id);
        const reused = live && entry.slots.get(live) === slot;
        const value = reused ? live : await restoreNativeItemState(state, {}, { linkedChildren: entry.links, session });
        owner = acquireNativeItemLinkOwner(value);
        entry.slots.set(value, slot);
        if (!reused) observe(entry, value, slot);
        return value;
      });
      return await operation(item);
    } catch (error) { failure = error; throw error; }
    finally {
      const errors = [];
      for (const cleanup of [() => owner?.release(), () => entry.links.flushReleases(), () => retained.release()]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
        failure?.message ?? 'Typed slot ownership cleanup failed.', failure ? { cause: failure } : undefined);
    }
  }
  async page({after=0n,limit=128}={}) {
    active(this);if(typeof after!=='bigint'||after<0n||!Number.isInteger(limit)||limit<1||limit>128)throw new TypeError('Typed pages require a bigint cursor and limit from 1 to 128.');
    const retained=this.retain(),entry=this.entry,owners=[];
    try {
      await flush(entry);
      const items=new Map(),entries=[];
      await entry.scope.run(async session=>{const rows=(await session.client.query(`SELECT cohort."Ordinal",cohort.slot_id,state.state FROM ${entry.rows} cohort
        JOIN ${entry.states} state ON state.scope_id=cohort.scope_id AND state.slot_id=cohort.slot_id
        WHERE cohort.view_id=$1 AND cohort."Ordinal">$2 ORDER BY cohort."Ordinal" LIMIT $3`,[this.id,after,limit])).rows;
      for(const row of rows){
        let item=items.get(row.slot_id);
        if(!item){item=await restoreNativeItemState(deserialize(row.state),{}, {linkedChildren:entry.links,session});
          owners.push(acquireNativeItemLinkOwner(item));items.set(row.slot_id,item);entry.slots.set(item,row.slot_id);observe(entry,item,row.slot_id);}
        entries.push({Ordinal:BigInt(row.Ordinal),item});
      }
      });
      let released=false;
      return Object.freeze({entries,release:async()=>{if(released)return;released=true;for(const owner of owners)owner.release();
        try{await entry.links.flushReleases();}finally{await retained.release();}}});
    } catch(error){for(const owner of owners)owner.release();await retained.release();throw error;}
  }
  async release(){
    if(this.released)return;this.released=true;
    const entry=this.entry;if(--entry.references)return;
    const failures=[];
    try{await entry.tail;}catch(error){failures.push(error);}
    try{await entry.scope.run(async session=>{
      await session.client.query(`DELETE FROM ${entry.rows} WHERE scope_id=$1`,[entry.id]);
      await session.client.query(`DELETE FROM ${entry.states} WHERE scope_id=$1`,[entry.id]);
      await entry.links.releaseStateScope(entry.id,{session});
      await entry.links.flushReleases({session});
    });}catch(error){failures.push(error);}finally{entry.scope.release();}
    if(failures.length)throw new AggregateError(failures,'Typed cohort release failed.');
  }
}
export async function createNativeItemCohort({linkedChildren,resolveLiveItem}) {
  if(resolveLiveItem!==undefined&&typeof resolveLiveItem!=='function')throw new TypeError('A live slot resolver must be a function.');
  const entry={id:randomUUID(),links:linkedChildren,resolveLiveItem,scope:linkedChildren.admitScope(),slots:new WeakMap(),tail:Promise.resolve(),references:0,error:null,
    states:`${q(linkedChildren.schemaName)}.item_states`,rows:`${q(linkedChildren.schemaName)}.item_cohorts`};
  return new NativeItemCohort(entry);
}
