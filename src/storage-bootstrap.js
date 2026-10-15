import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from './storage/index.js';
import { StorageFileSystem } from './storage/files.js';
import { PluginHost } from './plugins/host.js';
import { assertPortableMountStorageConfiguration } from './storage/portable-mount-contract.js';
import { isWithin, joinPath, normalizePath } from './storage/paths.js';

const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const writeCapabilities = { create:true,replace:true,mkdir:true,delete:true,rename:true,atomicReplace:true,conditionalWrite:false };
function validate(configuration) {
  if (!fields(configuration, ['instances','mounts','prefixes','bindings','ignorePrefixes'])
    || !['instances','mounts','prefixes'].every(key => Array.isArray(configuration[key]))
    || ['bindings','ignorePrefixes'].some(key => configuration[key] !== undefined && !Array.isArray(configuration[key]))) {
    throw new TypeError('Storage configuration requires instances, mounts and prefixes arrays.');
  }
  const ids = new Set();
  for (const instance of configuration.instances) {
    if (!fields(instance,['id','type','config']) || typeof instance.id !== 'string' || !instance.id || ids.has(instance.id)
      || typeof instance.type !== 'string' || !instance.type || !object(instance.config)) throw new TypeError('Each storage instance requires a unique id, type and configuration.');
    ids.add(instance.id);
  }
  for (const prefix of [...configuration.prefixes,...configuration.ignorePrefixes ?? []]) {
    if (!fields(prefix,['identityRoot','accessRoot','style','caseSensitive','returnAccess','purpose'])
      || prefix.purpose !== undefined && !['library','metadata','application'].includes(prefix.purpose)) throw new TypeError('Invalid storage path binding.');
  }
  for (const binding of configuration.bindings ?? []) if (!fields(binding,['itemId','accessPath'])) throw new TypeError('Invalid item access binding.');
  for (const mount of configuration.mounts) if (!ids.has(mount.instanceId)) throw new TypeError('A storage mount refers to an unknown instance.');
}
async function persist(filename, value) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    const file = await fs.open(temporary,'wx');
    try { await file.writeFile(JSON.stringify(value,null,2)+'\n'); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary,filename);
  } finally { await fs.rm(temporary,{force:true}); }
}
const dynamic = resolve => new Proxy({}, { get(_object,key) {
  const owner = resolve(), value = owner[key]; return typeof value === 'function' ? value.bind(owner) : value;
} });

function mountIdentityOverlays(vfs, declarations, groups) {
  const mounts = declarations.map(mount=>({...mount,path:normalizePath(mount.path),root:normalizePath(mount.root??'/')}));
  const occupied = new Map(mounts.map(mount=>[mount.path,mount]));
  const signature = mount=>JSON.stringify([mount.instanceId,mount.root,
    Object.keys(writeCapabilities).map(name=>mount.capabilities[name]===true)]);
  for (const prefixes of groups) for (const parent of prefixes) {
    const mapping = new IdentityAccessMap(); mapping.addPrefix(parent);
    for (const child of prefixes) {
      if (child===parent) continue;
      let target;
      try { target=mapping.resolve({identityPath:child.identityRoot,style:child.style}); }
      catch(error) { if(error.code==='not-found')continue; throw error; }
      const source = normalizePath(child.accessRoot);
      const covering = mounts.filter(mount=>isWithin(source,mount.path)).sort((left,right)=>right.path.length-left.path.length)[0];
      const projected = mounts.filter(mount=>isWithin(mount.path,source)).map(mount=>({...mount,path:joinPath(target,mount.path.slice(source.length))}));
      if (covering && covering.path!==source) projected.push({...covering,path:target,root:joinPath(covering.root,source.slice(covering.path.length))});
      for (const mount of projected) {
        const existing=occupied.get(mount.path);
        if (existing) {
          if(signature(existing)!==signature(mount)) throw new TypeError('Nested storage identity prefixes produce conflicting mounts at '+mount.path+'.');
          continue;
        }
        vfs.mount(mount,{deferred:true}); occupied.set(mount.path,mount);
      }
    }
  }
}

/** Independent identity prefixes select storage instances. Metadata and each
 * media root can use different plugins; the longest prefix wins. */
export async function createConfiguredStorage(filename, { environment = process.env, portableMountContract, plugins } = {}) {
  const ownsPlugins = !plugins;
  plugins ??= await PluginHost.open();
  filename ??= path.join(plugins.directory,'storage.json');
  let configuration, current, closed = false, initializing = true, tail = Promise.resolve();
  const extensions = new Map(), listeners = new Set();
  const notify = async () => { for (const listener of listeners) await listener(); };
  const credential = reference => {
    if (typeof reference !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference)) throw new TypeError('Storage credentialRef must name an environment variable.');
    const token = environment[reference];
    if (typeof token !== 'string' || !token || /[\r\n\0]/u.test(token)) throw new Error('The referenced storage credential is missing or invalid.');
    return token;
  };
  const build = async (definition, { tolerateUnavailable = false, strictType } = {}) => {
    validate(definition);
    const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap(), unavailable = [];
    try {
      for (const extension of extensions.values()) registry.registerType(extension.type,
        (config, options) => extension.create(config,{...options,resolveCredential:credential}));
      for (const instance of definition.instances) {
        if (!extensions.has(instance.type)) { unavailable.push({id:instance.id,type:instance.type,error:'Storage plugin is unavailable.'}); continue; }
        try {
          if (instance.config.credentialRef !== undefined) credential(instance.config.credentialRef);
          await registry.createInstance(instance.id,instance.type,instance.config);
        } catch (error) {
          if (!tolerateUnavailable || instance.type === strictType) throw error;
          unavailable.push({id:instance.id,type:instance.type,error:error.message});
        }
      }
      for (const mount of definition.mounts) vfs.mount(mount,{deferred:true});
      const mediaPrefixes=definition.prefixes.filter(prefix=>prefix.purpose!=='metadata');
      const metadataPrefixes=definition.prefixes.filter(prefix=>prefix.purpose==='metadata');
      for (const prefix of mediaPrefixes) identityMap.addPrefix(prefix);
      const metadataOverrides=new IdentityAccessMap();
      for(const prefix of metadataPrefixes)metadataOverrides.addPrefix(prefix);
      // Preserve declared identity/access namespaces while making nested roots
      // discoverable when their parent is enumerated through another mount.
      mountIdentityOverlays(vfs,definition.mounts,[mediaPrefixes,metadataPrefixes]);
      const fallback=(method,value)=>{try{return metadataOverrides[method](value);}catch(error){if(error.code!=='not-found')throw error;return identityMap[method](value);}};
      const metadataIdentityMap={resolve:value=>fallback('resolve',value),identityFor:value=>fallback('identityFor',value),
        exportState:()=>({prefixes:[...identityMap.exportState().prefixes,...metadataOverrides.exportState().prefixes],bindings:identityMap.exportState().bindings})};
      for (const binding of definition.bindings ?? []) identityMap.bind(binding.itemId,binding.accessPath);
      let ignoreIdentityMap = identityMap;
      if (definition.ignorePrefixes) {
        ignoreIdentityMap = new IdentityAccessMap();
        for (const prefix of [...mediaPrefixes,...definition.ignorePrefixes]) ignoreIdentityMap.addPrefix(prefix);
      }
      const contract = portableMountContract === undefined ? undefined : assertPortableMountStorageConfiguration(portableMountContract,definition);
      return { registry,vfs,identityMap,metadataIdentityMap,ignoreIdentityMap,unavailable,portableMountContract:contract };
    } catch (error) { await registry.close(); throw error; }
  };
  const change = async (definition, save = true, strictType) => {
    const candidate = await build(definition,{tolerateUnavailable:initializing || !save,strictType});
    try { if (save) await persist(filename,definition); }
    catch (error) { await candidate.registry.close(); throw error; }
    const previous = current; current = candidate; configuration = clone(definition);
    try { await previous?.registry.close(); } catch (error) { plugins.onError(error); }
    if (save && !initializing) await notify();
    return clone(configuration);
  };
  const enqueue = operation => {
    if (closed) return Promise.reject(Object.assign(new Error('Storage is closed.'),{status:503}));
    const promise = tail.then(operation); tail = promise.catch(()=>{}); return promise;
  };
  try {
    try {
      const text = await fs.readFile(filename,'utf8');
      try { configuration = JSON.parse(text); }
      catch { throw new TypeError('Storage configuration contains invalid JSON.'); }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; configuration = {instances:[],mounts:[],prefixes:[]}; }
    validate(configuration);
    // Defaults become ordinary persisted definitions. Removing a plugin never
    // removes identities, path bindings or configuration.
    for (const extension of plugins.entries('storage')) for (const definition of extension.defaults ?? []) {
      const id = `${extension.type}:${definition.id}`, accessRoot = `/__application/${id}`;
      if (configuration.prefixes.some(prefix => prefix.purpose!=='metadata' && (definition.style === 'windows'
        ? prefix.identityRoot.toLowerCase() === definition.identityRoot.toLowerCase() : prefix.identityRoot === definition.identityRoot))) continue;
      configuration.instances.push({id,type:extension.type,config:definition.config});
      configuration.mounts.push({path:accessRoot,instanceId:id,root:'/',capabilities:{...writeCapabilities}});
      configuration.prefixes.push({identityRoot:definition.identityRoot,accessRoot,style:definition.style,
        caseSensitive:definition.style !== 'windows',returnAccess:'Application storage identity is retained.',purpose:'application'});
    }
    await plugins.bind('storage', async extension => {
      if (typeof extension.type !== 'string' || typeof extension.create !== 'function' || extensions.has(extension.type)) throw new TypeError('Storage extension type must be unique and provide create().');
      extensions.set(extension.type,extension);
      try { if (!initializing) await enqueue(()=>change(configuration,false,extension.type)); }
      catch (error) { extensions.delete(extension.type); throw error; }
      return async () => {
        extensions.delete(extension.type);
        if (!initializing && !closed) await enqueue(()=>current.registry.unregisterType(extension.type));
      };
    });
    await change(configuration); initializing = false;
    const vfs = dynamic(()=>current.vfs), identityMap = dynamic(()=>current.identityMap), ignoreIdentityMap = dynamic(()=>current.ignoreIdentityMap);
    const metadataIdentityMap=dynamic(()=>current.metadataIdentityMap);
    const fileSystem = new StorageFileSystem({vfs,identityMap:metadataIdentityMap});
    const metadataPath = access => {
      let identity;
      try { identity=current.identityMap.identityFor(access); }
      catch (error) { if (error.code==='not-found') return access; throw error; }
      return current.metadataIdentityMap.resolve(identity);
    };
    const metadataVfs=new Proxy({}, {get(_target,key){
      const value=current.vfs[key];if(typeof value!=='function')return value;
      if(!['resolve','resolveFileHandle','capabilities','stat','list','openRead','write','mkdir','delete','rename'].includes(key))return value.bind(current.vfs);
      return (...args)=>{args[0]=metadataPath(args[0]);if(key==='rename')args[1]=metadataPath(args[1]);return current.vfs[key](...args);};
    }});
    const unsubscribe=plugins.subscribe(()=>enqueue(notify));
    return { vfs,identityMap,metadataVfs,metadataIdentityMap,ignoreIdentityMap,fileSystem,
      get portableMountContract() { return current.portableMountContract; },
      configuration:()=>clone(configuration), types:()=>[...extensions.keys()],
      status:()=>configuration.instances.map(instance=>({id:instance.id,type:instance.type,
        available:current.registry.hasInstance(instance.id),error:current.unavailable.find(entry=>entry.id===instance.id)?.error??null})),
      subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
      configure:value=>enqueue(()=>change(clone(value))),
      bindPath:value=>enqueue(async()=>{
        if (!fields(value,['identityRoot','instanceId','root','style','caseSensitive','returnAccess','capabilities','purpose'])) throw new TypeError('Invalid storage path binding.');
        const next = clone(configuration), existing = next.prefixes.find(prefix=>prefix.identityRoot===value.identityRoot && (prefix.purpose==='metadata')===(value.purpose==='metadata'));
        let accessRoot = existing?.accessRoot;
        let inherited = false;
        if (!accessRoot) {
          const mapping = new IdentityAccessMap();
          for (const prefix of next.prefixes.filter(prefix=>(prefix.purpose==='metadata')===(value.purpose==='metadata'))) mapping.addPrefix(prefix);
          try { accessRoot = mapping.resolve({identityPath:value.identityRoot,style:value.style}); inherited = true; }
          catch (error) { if (error.code !== 'not-found' || value.purpose !== 'metadata' && current.portableMountContract) throw error; }
        }
        accessRoot ??= '/locations/'+randomUUID();
        if (!inherited && !existing) {
          // A parent can be bound after its children. Keep those storage choices
          // visible in the parent's namespace without changing media identities.
          const parent = new IdentityAccessMap(); parent.addPrefix({...value,accessRoot});
          const moves = [];
          for (const prefix of next.prefixes.filter(prefix=>prefix.purpose!=='application' && (prefix.purpose==='metadata')===(value.purpose==='metadata'))) {
            try { moves.push({prefix,from:prefix.accessRoot,to:parent.resolve({identityPath:prefix.identityRoot,style:prefix.style})}); }
            catch (error) { if (error.code !== 'not-found') throw error; }
          }
          const relocate = location => {
            const move=moves.find(move=>isWithin(location,move.from));
            return move?joinPath(move.to,location.slice(move.from.length)):location;
          };
          next.mounts = next.mounts.map(mount=>({...mount,path:relocate(mount.path)}));
          next.prefixes = next.prefixes.filter(prefix=>!moves.some(move=>move.prefix===prefix))
            .map(prefix=>({...prefix,accessRoot:relocate(prefix.accessRoot)}));
          if(next.bindings)next.bindings=next.bindings.map(binding=>({...binding,accessPath:relocate(binding.accessPath)}));
          if(next.ignorePrefixes)next.ignorePrefixes=next.ignorePrefixes.map(prefix=>({...prefix,accessRoot:relocate(prefix.accessRoot)}));
        }
        next.prefixes = next.prefixes.filter(prefix=>prefix!==existing);
        next.mounts = next.mounts.filter(mount=>mount.path!==accessRoot);
        if (!inherited) next.prefixes.push({identityRoot:value.identityRoot,accessRoot,style:value.style,caseSensitive:value.caseSensitive,
          returnAccess:value.returnAccess,purpose:value.purpose});
        next.mounts.push({path:accessRoot,instanceId:value.instanceId,root:value.root??'/',capabilities:value.capabilities});
        return change(next);
      }),
      close:async()=>{if(closed)return;closed=true;unsubscribe();listeners.clear();await tail;try{if(ownsPlugins)await plugins.close();}finally{await current.registry.close();}},
    };
  } catch(error) { closed=true; if(ownsPlugins)await plugins.close().catch(()=>{}); await current?.registry.close(); throw error; }
}
