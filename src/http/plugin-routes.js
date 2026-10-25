import { httpError } from './binding.js';

export function registerPluginRoutes(register, { plugins, storage, storageReadiness }) {
  if (!plugins) return;
  const add = (method,path,handler,options) => register(method,path,async context=>{
    try { return await handler(context); }
    catch (error) { if (error instanceof TypeError && error.status === undefined) throw httpError(400,error.message); throw error; }
  },options);
  const options={policy:'RequiresElevation'}, body={...options,body:true};
  if (storage) {
    add('GET','/Storage/Configuration',()=>storage.configuration(),options);
    add('POST','/Storage/Configuration',context=>storage.configure(context.body),body);
    add('GET','/Storage/Types',()=>storage.types(),options);
    add('GET','/Storage/Status',()=>({instances:storage.status(),application:storageReadiness}),options);
    add('POST','/Storage/Bindings',context=>storage.bindPath(context.body),body);
  }
  add('GET','/Plugins',()=>plugins.list(),options);
  add('POST','/Plugins/Install',context=>{
    if(typeof context.body?.path!=='string')throw httpError(400,'A plugin package directory is required.');
    return plugins.install(context.body.path);
  },body);
  add('GET','/Plugins/{pluginId}',context=>plugins.get(context.params.pluginId),options);
  add('GET','/Plugins/{pluginId}/Configuration',context=>plugins.get(context.params.pluginId),options);
  add('POST','/Plugins/{pluginId}/Configuration',context=>plugins.configure(context.params.pluginId,context.body),body);
  add('POST','/Plugins/{pluginId}/Enabled',context=>plugins.setEnabled(context.params.pluginId,context.body?.enabled),body);
  add('POST','/Plugins/{pluginId}/Update',context=>{
    if(typeof context.body?.path!=='string')throw httpError(400,'A plugin package directory is required.');
    return plugins.update(context.params.pluginId,context.body.path);
  },body);
  add('DELETE','/Plugins/{pluginId}',context=>plugins.uninstall(context.params.pluginId),options);
  add('DELETE','/Plugins/{pluginId}/Cache',context=>plugins.clearCache(context.params.pluginId),options);
}
