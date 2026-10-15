import path from 'node:path';
import model from './configuration-model.json' with { type:'json' };
import { nativeConfiguration } from '@mediamanager/plugin-sdk/configuration';
import { nativeGuid } from '@mediamanager/plugin-sdk/users/native';
import { readUserData } from '@mediamanager/plugin-sdk/sessions/user-data';
import { createNfoPlugin } from './plugin.js';

export const configurationCodec=nativeConfiguration(model,'nfo');
export const validateConfiguration=values=>configurationCodec.validate(values);
export async function activate(context) {
  const directory=context.paths.configurationDirectoryPath??(context.paths.programDataPath&&path.resolve(context.paths.programDataPath,'..','config'));
  const configuration=configurationCodec.validate(context.configuration,await configurationCodec.load(directory&&path.join(directory,'xbmcmetadata.xml'),{onError:context.logger.error}));
  return {configuration,fields:configurationCodec.fields,async connect({metadata,metadataVfs:vfs,store,userData,spoolRoot,fileSystem}) {
    if(!metadata)return;
    await context.register('metadata',createNfoPlugin({vfs,configuration,store,userData,spoolRoot,fileSystem,logger:context.logger}));
    await context.register('context',{async enrich(loaded,{database}){
      if(configuration.UserId?.trim()&&!loaded.item.IsFolder) {
        let id;try{id=nativeGuid(configuration.UserId);}catch{}
        if(id&&(await database.rows('Users',{where:{Id:id}})).length)loaded.context.userData=await readUserData(database,id,loaded.item);
      }
      if(configuration.EnableExtraThumbsDuplication)loaded.extraImagePaths=({index,extension,folder})=>[path[folder.includes('\\')?'win32':'posix'].join(folder,'extrathumbs',`thumb${index}${extension}`)];
    }});
  }};
}
