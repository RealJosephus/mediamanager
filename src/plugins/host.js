import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateMetadataExtension } from '../metadata/registry.js';
import { acquireOperationLease } from '../migration/operation-lease.js';
import { liveTvSignalPositions, validateLiveTvExtension, validateLiveTvResult, validateLiveTvStreamRequest,
  validateOwnedLiveTvStream } from './live-tv-contract.js';
import { inspectPackage, stagePackage, verifyRelease, physicalDirectory, officialPackagesPath, validPluginId } from './package.js';
import { createConfigurationBinding } from '../../packages/plugin-sdk/configuration.js';

const error = (status,message) => Object.assign(new Error(message),{status,statusCode:status});
const object = value => value !== null && typeof value==='object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const kinds = new Set(['metadata','similar','intro','storage','task','route','context','imagePaths','tuner','listings','channel']);
const signals = { getMetadata:1, search:1, fetch:1, hasChanged:1, save:1, prepareSave:1, validateSave:1, preflight:1,
  getImages:1, getImage:1, getImageResponse:1, getIntros:1, getReferences:2, run:0, enrich:1, handle:0, create:1 };
const storageSignals = {stat:1,listPage:1,openRead:1,write:2,mkdir:1,delete:1,rename:2,health:0,fileStat:1,openFile:2};

async function atomicJson(filename,value) {
  const temporary=filename+'.'+randomUUID()+'.tmp';
  const file=await fs.open(temporary,'wx');
  try {
    try { await file.writeFile(JSON.stringify(value,null,2)+'\n'); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary,filename);
  } finally { await fs.rm(temporary,{force:true}); }
}

class PluginScope {
  controller = new AbortController();
  pending = new Set();
  disposers = [];
  closeFailures = [];
  resources = new Set();
  liveSharing = new WeakMap();
  active = true;
  admitted = false;
  own(dispose) {
    if(this.active)this.disposers.push(dispose);
    else this.track(Promise.resolve().then(dispose).catch(cause=>this.closeFailures.push(cause)));
  }
  track(value) {
    if (!value || typeof value.then !== 'function') return value;
    const promise=Promise.resolve(value); this.pending.add(promise);
    void promise.then(()=>this.pending.delete(promise),()=>this.pending.delete(promise)); return promise;
  }
  call(target,key,args,signalPositions=signals,iterate=true) {
    if(!this.active || !this.admitted && key !== 'create')throw error(503,'The plugin is unavailable.');
    args=[...args]; const position=signalPositions[key];
    if(position!==undefined) {
      if(key==='getReferences') args[position]=args[position]?AbortSignal.any([args[position],this.controller.signal]):this.controller.signal;
      else { const options=args[position]??{}; args[position]={...options,signal:options.signal?AbortSignal.any([options.signal,this.controller.signal]):this.controller.signal}; }
    }
    const result=target[key](...args);
    if(iterate&&result?.[Symbol.asyncIterator]) {
      const scope=this,iterator=result[Symbol.asyncIterator]();let closing,done=false;
      const close=value=>closing??=(async()=>{done=true;scope.resources.delete(close);return await iterator.return?.(value)??{done:true,value};})();
      scope.resources.add(close);
      const advance=(method,args)=>{
        if(!scope.active||!scope.admitted)return Promise.reject(error(503,'The plugin is unavailable.'));
        if(done)return Promise.resolve({done:true});
        return scope.track(Promise.resolve().then(()=>iterator[method](...args)).then(value=>{
          scope.controller.signal.throwIfAborted();if(value.done){done=true;scope.resources.delete(close);}return value;
        }).catch(async cause=>{await close();throw cause;}));
      };
      return {[Symbol.asyncIterator](){return this;},next:(...args)=>advance('next',args),
        return:value=>scope.track(close(value)),throw:cause=>typeof iterator.throw==='function'?advance('throw',[cause]):scope.track(close().then(()=>{throw cause;}))};
    }
    return this.track(result);
  }
  sharingCapability(resource,sourceId,tunerHostId) {
    const existing=this.liveSharing.get(resource);
    if(existing){if(existing.sourceId!==sourceId||existing.tunerHostId!==tunerHostId)throw new TypeError('A shared input cannot change source or tuner host identity.');return existing.facade;}
    const scope=this,facade=Object.freeze({
      get enabled(){return scope.active&&scope.admitted&&resource.enabled===true;},
      retain(options={}) {
        if(!scope.active||!scope.admitted)throw error(503,'The plugin is unavailable.');
        const signal=options.signal?AbortSignal.any([options.signal,scope.controller.signal]):scope.controller.signal;
        signal.throwIfAborted();
        return scope.track(Promise.resolve().then(()=>{
          if(!scope.active||!scope.admitted||resource.enabled!==true)throw error(503,'The shared live input is unavailable.');
          signal.throwIfAborted();return resource.retain({...options,signal});
        }).then(child=>scope.liveStream(child,signal,sourceId,resource,tunerHostId)));
      },
    });
    this.liveSharing.set(resource,{sourceId,tunerHostId,facade});return facade;
  }
  async liveStream(resource,signal,sourceId,sharing,tunerHostId) {
    const scope=this;let closing,iterator;
    const aborted=()=>{void close().catch(()=>{});};
    const close=()=>{
      if(closing)return closing;
      scope.resources.delete(close);signal.removeEventListener('abort',aborted);
      closing=scope.track((async()=>{
        const results=await Promise.allSettled([
          Promise.resolve().then(()=>resource?.close?.()),
          Promise.resolve().then(()=>iterator?.return?.()),
        ]);
        const failures=results.filter(value=>value.status==='rejected').map(value=>value.reason);
        if(failures.length)throw new AggregateError(failures,'The live stream lease failed to close.');
      })().catch(cause=>{scope.closeFailures.push(cause);throw cause;}));
      return closing;
    };
    // Own even an invalid response before validation. Already admitted work
    // can acquire its upstream after plugin cancellation has begun.
    scope.resources.add(close);
    try {
      iterator=typeof resource?.stream?.[Symbol.asyncIterator]==='function'?resource.stream[Symbol.asyncIterator]():undefined;
      validateOwnedLiveTvStream(resource);
      if(resource.mediaSource.Id!==sourceId)throw new TypeError('The opened live stream has a different source identity.');
      if(sharing&&resource.sharing!==sharing)throw new TypeError('A retained live stream must belong to the same shared input.');
      if(sharing&&resource.tunerHostId!==tunerHostId)throw new TypeError('A retained live stream must belong to the same tuner host.');
      if(!scope.active||!scope.admitted)throw error(503,'The plugin is unavailable.');
      signal.throwIfAborted();
      const available=()=>{if(closing||!scope.active||!scope.admitted)throw error(503,'The live stream lease is closed.');signal.throwIfAborted();};
      const stream=iterator&&{[Symbol.asyncIterator](){return this;},
        next(...args){return scope.track(Promise.resolve().then(()=>{available();return iterator.next(...args);}).then(async value=>{
          available();if(value.done)await close();else if(!(value.value instanceof Uint8Array))throw new TypeError('A live stream body must yield bytes.');return value;
        }).catch(async cause=>{await close();throw cause;}));},
        return(value){return scope.track(close().then(()=>({done:true,value})));},
      };
      const lease=Object.freeze({mode:'native',...(resource.profile===undefined?{}:{profile:resource.profile}),
        tunerHostId:resource.tunerHostId,mediaSource:structuredClone(resource.mediaSource),...(stream?{stream}:{}),
        ...(resource.sharing?{sharing:scope.sharingCapability(resource.sharing,sourceId,resource.tunerHostId)}:{}),close});
      signal.addEventListener('abort',aborted,{once:true});signal.throwIfAborted();
      return lease;
    } catch(cause) {
      try{await close();}catch(cleanup){throw new AggregateError([cause,cleanup],'A live stream response was rejected and cleanup failed.');}
      throw cause;
    }
  }
  wrap(value,kind) {
    const scope=this, wrappers=new Map(), liveTv=liveTvSignalPositions[kind];let proxy;
    return proxy=new Proxy(Object.create(liveTv?null:Object.getPrototypeOf(value)),{get(_target,key){
      const target=value;
      const property=Reflect.get(target,key,target);
      if(key==='providers'&&!liveTv)return property.map(provider=>scope.wrap(provider));
      if(typeof property!=='function')return property;
      if(liveTvSignalPositions[kind]&&!Object.hasOwn(liveTvSignalPositions[kind],key))return undefined;
      if((kind==='adapter'||kind==='resource')&&key==='close')return property.bind(target);
      if(!wrappers.has(key))wrappers.set(key,(...args)=>{
        const positions=liveTvSignalPositions[kind];
        if(positions&&(!scope.active||!scope.admitted))throw error(503,'The plugin is unavailable.');
        const signal=positions&&(args[positions[key]]?.signal?AbortSignal.any([args[positions[key]].signal,scope.controller.signal]):scope.controller.signal);
        signal?.throwIfAborted();
        if(positions&&key==='getChannelStream')validateLiveTvStreamRequest(...args);
        const liveSourceId=positions&&key==='getChannelStream'?args[3].source.mediaSource.Id:undefined;
        const result=scope.call(target,key,args,positions??(kind==='adapter'?storageSignals:signals),!positions);
        if(positions)return scope.track(Promise.resolve(result).then(async result=>{
          if(kind==='tuner'&&key==='getChannelStream')return scope.liveStream(result,signal,liveSourceId);
          if(!scope.active||!scope.admitted)throw error(503,'The plugin is unavailable.');
          signal.throwIfAborted();
          validateLiveTvResult(kind,key,result);
          if(key==='getChannelStreamMediaSources'||key==='getChannelItemMediaInfo') {
            return result.map(source=>Object.freeze({mode:'native',
              ...(source.profile===undefined?{}:{profile:source.profile}),mediaSource:structuredClone(source.mediaSource)}));
          }
          if(kind==='channel'&&(key==='getChannelItems'||key==='getChannelImage'))return structuredClone(result);
          return result;
        }));
        if(kind==='storage'&&key==='create')return Promise.resolve(result).then(adapter=>scope.wrap(adapter,'adapter'));
        if(key==='prepareSave')return scope.track(Promise.resolve(result).then(prepared=>{
          let closed=false;
          const close=async()=>{if(closed)return;closed=true;scope.resources.delete(close);await prepared.close?.();};
          scope.resources.add(close);
          return scope.wrap({...prepared,close,async apply(...values){try{return await prepared.apply(...values);}finally{await close();}}},'resource');
        }));
        return result;
      });
      return wrappers.get(key);
    },has(_target,key){return key in value&&(!liveTv||typeof value[key]!=='function'||Object.hasOwn(liveTv,key));},
      ownKeys(){return Reflect.ownKeys(value).filter(key=>!liveTv||typeof value[key]!=='function'||Object.hasOwn(liveTv,key));},
      getOwnPropertyDescriptor(_target,key){
        const descriptor=Reflect.getOwnPropertyDescriptor(value,key);if(!descriptor)return;
        if(liveTv){const wrapped=proxy[key];if(typeof descriptor.value==='function'&&wrapped===undefined)return;
          return {value:wrapped,writable:false,enumerable:descriptor.enumerable,configurable:true};}
        return {...descriptor,configurable:true};
      }});
  }
  async close() {
    this.active=false;this.controller.abort();
    const results=[];
    while(this.resources.size||this.disposers.length||this.pending.size){
      results.push(...await Promise.allSettled([...this.resources,...this.disposers.splice(0).reverse()].map(dispose=>Promise.resolve().then(dispose))));
      while(this.pending.size)await Promise.allSettled([...this.pending]);
    }
    const failures=[...results.filter(r=>r.status==='rejected').map(r=>r.reason),...this.closeFailures];
    if(failures.length)throw new AggregateError(failures,'Plugin resources failed to close.');
  }
}

export class PluginHost {
  #state={generation:randomUUID(),plugins:{}};
  #active=new Map();
  #failures=new Map();
  #tail=Promise.resolve();
  #closing;
  #closed=false;
  #services;
  #sinks=new Map();
  #listeners=new Set();
  #lease;
  static async open(options={}) {const host=new PluginHost(options);try{await host.#open();return host;}catch(e){await host.close().catch(()=>{});throw e;}}
  constructor(paths={}) {
    const {directory,programDataPath,configurationDirectoryPath,dataPath,imageCachePath,preinstalled=officialPackagesPath,options={},configurationBindings=new Map(),onError=()=>{}}=paths;
    this.directory=directory??(programDataPath&&path.join(programDataPath,'plugins','node'));
    this.paths={programDataPath,configurationDirectoryPath,dataPath,get metadataPath(){return paths.metadataPath;},get cachePath(){return paths.cachePath;},imageCachePath};this.preinstalled=preinstalled;this.options=options;this.onError=onError;
    this.configurationBindings=configurationBindings;
  }
  async #open() {
    this.temporary=!this.directory;
    this.directory??=await fs.mkdtemp(path.join(os.tmpdir(),'mediamanager-plugins-'));
    this.paths.pluginStoragePath = this.directory;
    await physicalDirectory(this.directory,{missing:true}); await fs.mkdir(this.directory,{recursive:true}); await physicalDirectory(this.directory);
    let identity=await fs.realpath(this.directory);
    if(process.platform==='win32')identity=identity.replace(/^\\\\\?\\UNC\\/u,'\\\\').replace(/^\\\\\?\\/u,'').toLowerCase();
    try{this.#lease=await acquireOperationLease('plugin-host:'+identity,{label:'Plugin host'});}
    catch(e){if(['EADDRINUSE','EACCES'].includes(e.cause?.code))throw error(409,'The plugin directory is already in use.');throw e;}
    const lock=path.join(this.directory,'host.lock');
    // This is diagnostic state; only the OS lease admits an owner.
    await atomicJson(lock,{pid:process.pid,token:randomUUID()});
    try{this.#state=JSON.parse(await fs.readFile(path.join(this.directory,'state.json'),'utf8'));}
    catch(e){if(e.code!=='ENOENT')throw e;}
    if(!object(this.#state.plugins)||typeof this.#state.generation!=='string')throw new TypeError('Invalid plugin state.');
    for (const [id,record] of Object.entries(this.#state.plugins)) {
      if (!validPluginId(id) || !object(record) || typeof record.enabled !== 'boolean'
        || (record.configurationKey === undefined ? !object(record.configuration) : typeof record.configurationKey !== 'string' || Object.hasOwn(record,'configuration'))
        || record.package !== null && (!object(record.package) || record.package.manifest?.mediamanager?.id !== id
          || record.package.manifest.mediamanager.configurationKey !== record.configurationKey)) {
        throw new TypeError('Invalid persistent plugin record.');
      }
    }
    // The state generation is the commit record. Interrupted preparations never replace it.
    await this.#clearTransaction();
    if(this.preinstalled) {
      let entries=[];
      try{entries=await fs.readdir(this.preinstalled,{withFileTypes:true});}catch(e){this.onError(e);}
      for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
        if(!entry.isDirectory())continue;
        try {
          const source=path.join(this.preinstalled,entry.name),{manifest}=await inspectPackage(source),id=manifest.mediamanager.id;
          if(!Object.hasOwn(this.#state.plugins,id)) {
            this.#state.plugins[id]=this.#record(await stagePackage(source,this.directory),true);
          }
        }catch(e){this.onError(e);}
      }
    }
    await this.#persist();
    for(const [id,record] of Object.entries(this.#state.plugins))if(record.package&&record.enabled) {
      try{await this.#start(id,record);}catch(e){this.#failures.set(id,e.message);this.onError(e);}
    }
    await this.#collectPackages();
  }
  #enqueue(operation) {
    if(this.#closed)return Promise.reject(error(503,'The plugin host is closing.'));
    const pending=this.#tail.then(()=>{this.#lease.assertHeld();return operation();});this.#tail=pending.catch(()=>{});return pending;
  }
  async #persist() {await atomicJson(path.join(this.directory,'state.json'),this.#state);}
  #record(staged,enabled,previous) {
    const key=staged.manifest.mediamanager.configurationKey;
    if(key!==undefined&&(!key||typeof key!=='string'))throw new TypeError('A named plugin configuration key must be a nonempty string.');
    return {package:staged,enabled,...(key===undefined?{configuration:previous?.configuration??{}}:{configurationKey:key})};
  }
  #binding(id,record) {
    if(record.configurationKey!==undefined) {
      const binding=this.configurationBindings.get(record.configurationKey);
      if(!binding)throw error(503,'The plugin named configuration store is unavailable.');
      return binding;
    }
    return createConfigurationBinding({getCurrent:()=>record.configuration,
      save:configuration=>this.#change(id,{...record,configuration:clone(configuration)})});
  }
  entries(kind) {return [...this.#active.values()].filter(active=>active.scope.admitted).flatMap(active=>active.entries.filter(entry=>entry.kind===kind).map(entry=>entry.value));}
  async bind(kind,install) {
    if(this.#sinks.has(kind))throw new Error('Extension consumer is already bound.');
    this.#sinks.set(kind,install);
    for(const active of this.#active.values())for(const entry of active.entries.filter(entry=>entry.kind===kind))entry.dispose=await install(entry.value,active.id);
  }
  async connect(services) {
    this.#services=services;
    for(const [id,active]of [...this.#active])try{await active.module.connect?.(services);}catch(e){await this.#stop(id);this.#failures.set(id,e.message);this.onError(e);}
  }
  async #start(id,record,{admit=true}={}) {
    const directory=await verifyRelease(this.directory,record.package), scope=new PluginScope();
    const active={id,scope,entries:[],module:{}};
    const dataPath=path.join(this.directory,'data',id),cachePath=path.join(this.directory,'cache',id);
    await physicalDirectory(dataPath,{missing:true});await physicalDirectory(cachePath,{missing:true});
    await fs.mkdir(dataPath,{recursive:true});await fs.mkdir(cachePath,{recursive:true});
    await physicalDirectory(dataPath); await physicalDirectory(cachePath);
    const binding=this.#binding(id,record);
    const activationConfiguration=record.configurationKey===undefined?clone(binding.getCurrent()):undefined;
    const getConfiguration=record.configurationKey===undefined?()=>activationConfiguration:()=>binding.getCurrent();
    const context={id,paths:this.paths,dataPath,cachePath,getConfiguration,options:this.options[id]??{},
      signal:scope.controller.signal,own:dispose=>{if(typeof dispose!=='function')throw new TypeError('A disposer is required.');scope.own(dispose);},
      run:operation=>{if(!scope.active)throw error(503,'The plugin is stopped.');return scope.track(Promise.resolve().then(()=>operation(scope.controller.signal)));},
      logger:{error:this.onError,warn:this.onError},
      register:async(kind,value)=>{
        if(!kinds.has(kind)||!object(value)||!scope.active)throw new TypeError('Invalid plugin extension registration.');
        if(kind==='metadata')validateMetadataExtension(value);
        if(kind==='intro'&&typeof value.getIntros!=='function')throw new TypeError('An intro provider requires getIntros.');
        if(liveTvSignalPositions[kind])validateLiveTvExtension(kind,value);
        const wrapped=scope.wrap(value,kind),entry={kind,value:wrapped};
        active.entries.push(entry);
        const install=this.#sinks.get(kind);if(install)entry.dispose=await install(wrapped,id);
        return wrapped;
      }};
    this.#active.set(id,active);
    try {
      const module=await import(pathToFileURL(path.join(directory,record.package.manifest.mediamanager.entry)).href+'?activation='+randomUUID());
      if(typeof module.activate!=='function')throw new TypeError('Plugin entry must export activate(context).');
      await module.validateConfiguration?.(clone(binding.getCurrent()));
      active.module=await module.activate(Object.freeze(context))??{};
      if(active.module.close)scope.own(()=>active.module.close());
      if(this.#services)await active.module.connect?.(this.#services);
      scope.admitted=admit;this.#failures.delete(id);
    }catch(e){await this.#stop(id).catch(cleanup=>this.onError(cleanup));throw e;}
  }
  async #stop(id) {
    const active=this.#active.get(id);if(!active)return;
    this.#active.delete(id);active.scope.active=false;active.scope.controller.abort();
    const results=await Promise.allSettled(active.entries.map(entry=>Promise.resolve().then(()=>entry.dispose?.())));
    try{await active.scope.close();}catch(e){results.push({status:'rejected',reason:e});}
    const failures=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(failures.length)throw new AggregateError(failures,'Plugin shutdown failed.');
  }
  list() {return Object.entries(this.#state.plugins).map(([id,record])=>({id,name:record.package?.manifest.mediamanager.name??id,
    version:record.package?.manifest.version??null,digest:record.package?.digest??null,installed:Boolean(record.package),enabled:record.enabled,
    status:this.#active.has(id)?'active':this.#failures.has(id)?'failed':record.package?record.enabled?'unavailable':'disabled':'uninstalled',
    error:this.#failures.get(id)??null,configuration:clone(this.#binding(id,record).getCurrent()),
    effectiveConfiguration:clone(this.#active.get(id)?.module.configuration??this.#binding(id,record).getCurrent()),
    fields:clone(this.#active.get(id)?.module.fields??this.#binding(id,record).fields),extensions:this.#active.get(id)?.entries.map(e=>e.kind)??[]}));}
  get(id) {const entry=this.list().find(entry=>entry.id===id);if(!entry)throw error(404,'Plugin not found.');return entry;}
  subscribe(listener) {this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  async #change(id,next) {
    const previous=this.#state.plugins[id];
    if(next.package && (next.enabled || next.package.digest !== previous?.package?.digest
      || JSON.stringify(next.configuration) !== JSON.stringify(previous?.configuration))) {
      const directory=await verifyRelease(this.directory,next.package);
      const module=await import(pathToFileURL(path.join(directory,next.package.manifest.mediamanager.entry)).href);
      if(typeof module.activate!=='function')throw new TypeError('Plugin entry must export activate(context).');
      await module.validateConfiguration?.(clone(this.#binding(id,next).getCurrent()));
    }
    await atomicJson(path.join(this.directory,'transaction.json'),{id,baseGeneration:this.#state.generation,previous:previous??null,next});
    try {
      await this.#stop(id);
      if(next.package&&next.enabled)await this.#start(id,next,{admit:false});
      const state={generation:randomUUID(),plugins:{...this.#state.plugins,[id]:next}};
      await atomicJson(path.join(this.directory,'state.json'),state);this.#state=state;
      const active=this.#active.get(id);if(active)active.scope.admitted=true;
      this.#failures.delete(id);
    }catch(e){
      await this.#stop(id).catch(cleanup=>this.onError(cleanup));
      if(previous?.package&&previous.enabled)try{await this.#start(id,previous);}catch(recovery){this.#failures.set(id,recovery.message);throw new AggregateError([e,recovery],'Plugin change and recovery failed.');}
      throw e;
    }finally{await this.#clearTransaction();}
    await this.#collectPackages();
    await this.#notify(id);
    return this.get(id);
  }
  update(id,source) {return this.install(source,{update:true,id});}
  install(source,{update=false,id:expectedId}={}) {return this.#enqueue(async()=>{
    const staged=await stagePackage(source,this.directory),id=staged.manifest.mediamanager.id,old=this.#state.plugins[id];
    try{
      if(expectedId!==undefined&&id!==expectedId)throw error(409,'Update package has a different plugin identity.');
      if(update&&!old?.package)throw error(404,'Plugin is not installed.');
      if(!update&&old?.package)throw error(409,'Plugin is already installed.');
      if(update&&staged.manifest.name!==old.package.manifest.name)throw error(409,'Plugin package identity cannot change during update.');
      return await this.#change(id,this.#record(staged,old?.enabled??true,old));
    }finally{await this.#collectPackages();}
  });}
  configure(id,configuration) {return this.#enqueue(async()=>{
    const record=this.#required(id);if(!object(configuration))throw error(400,'Plugin configuration must be an object.');
    const binding=this.#binding(id,record);
    if(record.configurationKey!==undefined) {
      const directory=await verifyRelease(this.directory,record.package);
      const module=await import(pathToFileURL(path.join(directory,record.package.manifest.mediamanager.entry)).href);
      const value={...binding.getCurrent(),...configuration};
      await module.validateConfiguration?.(value);
      await binding.save(value);
      await this.#notify(id);
      return this.get(id);
    }
    return binding.save(configuration);
  });}
  setEnabled(id,enabled) {return this.#enqueue(async()=>{if(typeof enabled!=='boolean')throw error(400,'Enabled must be a boolean.');return this.#change(id,{...this.#required(id),enabled});});}
  uninstall(id) {return this.#enqueue(async()=>{const old=this.#required(id);return this.#change(id,{...old,package:null,enabled:false});});}
  async #notify(id) {for (const listener of this.#listeners) try { await listener(this.get(id)); } catch (e) { this.onError(e); }}
  clearCache(id) {return this.#enqueue(async()=>{const record=this.#required(id),failures=[];
    try{await this.#stop(id);await fs.rm(path.join(this.directory,'cache',id),{recursive:true,force:true});}catch(e){failures.push(e);}
    if(record.enabled)try{await this.#start(id,record);}catch(e){this.#failures.set(id,e.message);failures.push(e);}
    await this.#notify(id);
    if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'Plugin cache cleanup and restart failed.');
    return this.get(id);});}
  #required(id) {if(!validPluginId(id)||!this.#state.plugins[id]?.package)throw error(404,'Plugin is not installed.');return this.#state.plugins[id];}
  async #clearTransaction() {
    try{await fs.rm(path.join(this.directory,'transaction.json'),{force:true});}
    catch(cause){try{this.onError(cause);}catch{}}
  }
  async #collectPackages() {
    const retained=new Set(Object.values(this.#state.plugins).filter(r=>r.package).map(r=>r.package.release));
    // Cleanup and its diagnostics cannot change a committed result or replace
    // the original failure. Retained releases are never candidates for removal.
    const report=cause=>{try{this.onError(cause);}catch{}};
    const root=path.join(this.directory,'packages');let entries;
    try{await fs.mkdir(root,{recursive:true});entries=await fs.readdir(root,{withFileTypes:true});}
    catch(cause){report(cause);return;}
    for(const entry of entries)if(entry.isDirectory()&&/^[0-9a-f-]{36}$/.test(entry.name)&&!retained.has(entry.name)){
      try{await fs.rm(path.join(root,entry.name),{recursive:true,force:true});}catch(cause){report(cause);}
    }
  }
  beginClose() {this.#closed=true;return this.#tail;}
  close() {
    if(this.#closing)return this.#closing;this.beginClose();
    return this.#closing=(async()=>{await this.#tail;const results=await Promise.allSettled([...this.#active.keys()].map(id=>this.#stop(id)));
      const attempt=async operation=>{try{await operation();}catch(reason){results.push({status:'rejected',reason});}};
      if(this.#lease)await attempt(()=>fs.rm(path.join(this.directory,'host.lock'),{force:true}));
      if(this.temporary&&this.directory)await attempt(()=>fs.rm(this.directory,{recursive:true,force:true}));
      if(this.#lease){await attempt(()=>this.#lease.release());this.#lease=undefined;}
      const failures=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(failures.length)throw new AggregateError(failures,'Plugin host shutdown failed.');})();
  }
}
