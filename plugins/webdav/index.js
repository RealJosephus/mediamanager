import { WebDavAdapter } from './adapter.js';
const fields=['baseUrl','credentialRef','timeoutMs','pageSize','maxXmlBytes','capabilities'];
export function validateConfiguration(configuration) {
  if(Object.keys(configuration).length)throw new TypeError('WebDAV configuration belongs to each storage instance.');
}
export async function activate(context) {
  validateConfiguration(context.configuration);
  await context.register('storage',{type:'webdav',create(config,options){
    if(Object.keys(config).some(key=>!fields.includes(key)))throw new TypeError('WebDAV storage configuration contains unsupported fields.');
    return new WebDavAdapter(config,{...options,...context.options});
  }});
}
