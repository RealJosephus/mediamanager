import path from 'node:path';
import { namedConfigurationCodec } from '@mediamanager/plugin-sdk/configuration';
import { createNfoPlugin } from './plugin.js';

export const configurationCodec=namedConfigurationCodec('xbmcmetadata');
export const validateConfiguration=values=>configurationCodec.validate(values);
export async function activate(context) {
  const getConfiguration = context.getConfiguration;
  return {get configuration(){return getConfiguration();},fields:configurationCodec.fields,async connect({metadata,metadataVfs:vfs,store,userData,spoolRoot,fileSystem}) {
    if(!metadata)return;
    await context.register('metadata',createNfoPlugin({vfs,getConfiguration,store,userData,spoolRoot,fileSystem,logger:context.logger}));
    await context.register('context',{async enrich(loaded){
      loaded.extraImagePaths=({index,extension,folder})=>getConfiguration().EnableExtraThumbsDuplication
        ? [path[folder.includes('\\')?'win32':'posix'].join(folder,'extrathumbs',`thumb${index}${extension}`)] : [];
    }});
  }};
}
