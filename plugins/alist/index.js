import { AListAdapter } from './adapter.js';
const fields=['baseUrl','credentialRef','password','timeoutMs','pageSize','maxJsonBytes','capabilities'];
export function validateConfiguration(configuration) {
  if(Object.keys(configuration).length)throw new TypeError('AList configuration belongs to each storage instance.');
}
export async function activate(context) {
  validateConfiguration(context.configuration);
  await context.register('storage',{type:'alist',create(config,options){
    if(Object.keys(config).some(key=>!fields.includes(key)))throw new TypeError('AList storage configuration contains unsupported fields.');
    return new AListAdapter(config,{...options,...context.options});
  }});
}
