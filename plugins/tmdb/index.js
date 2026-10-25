import path from 'node:path';
import model from './configuration-model.json' with { type:'json' };
import { nativeConfiguration } from '@mediamanager/plugin-sdk/configuration';
import { TmdbClient } from './client.js';
import { createTmdbPlugin } from './plugin.js';
import { createTmdbSeriesSimilarProvider, createTmdbMovieSimilarProvider } from './similar.js';
import { TmdbMissingEpisodeLifecycleHost } from './missing-episode-lifecycle.js';
import { TmdbUpcomingEpisodesMaintenance } from './upcoming-episodes.js';
import { TmdbUpcomingEpisodesTaskWorker } from './task.js';

export const configurationCodec=nativeConfiguration(model,'tmdb');
export const validateConfiguration=values=>configurationCodec.validate(values);
export async function activate(context) {
  const filename=context.paths.programDataPath&&path.join(context.paths.programDataPath,'plugins','configurations','Jellyfin.Plugin.Tmdb.xml');
  const loaded=await configurationCodec.load(filename,{rewriteValid:false,onError:context.logger.error});
  const configuration=configurationCodec.validate(context.getConfiguration(),loaded);
  const client=new TmdbClient({...context.options,configuration});context.own(()=>client.close());
  for(const create of [createTmdbSeriesSimilarProvider,createTmdbMovieSimilarProvider]) {
    await context.register('similar',{...create({client,logger:context.logger}),cachePath:context.cachePath});
  }
  await context.register('route',{method:'GET',path:'/Tmdb/ClientConfiguration',async handle({signal}){
    try{const images=(await client.getClientConfiguration({signal}))?.images;if(images==null)return null;
      return {BackdropSizes:images.backdrop_sizes,BaseUrl:images.base_url,LogoSizes:images.logo_sizes,PosterSizes:images.poster_sizes,
        ProfileSizes:images.profile_sizes,SecureBaseUrl:images.secure_base_url,StillSizes:images.still_sizes};
    }catch(cause){throw new Error('TMDB client configuration request failed.',{cause});}
  }});
  return {configuration,fields:configurationCodec.fields,async connect(services){
    const {seriesLifecycle,itemCreation,loadContext,metadataUpdates,metadataImages,metadata,folderValidation,store,library}=services;
    const lifecycle=seriesLifecycle&&new TmdbMissingEpisodeLifecycleHost({seriesLifecycle,itemCreation,loadContext,updates:metadataUpdates,
      images:metadataImages,refreshSeason:(...args)=>metadata.refreshSeasonWithLiveSeries(...args),logger:context.logger});
    if(metadata)await context.register('metadata',createTmdbPlugin({client,lifecycle}));
    if(lifecycle&&folderValidation) {
      const maintenance=new TmdbUpcomingEpisodesMaintenance({store,library,lifecycle,configuration,onError:context.logger.error});
      await context.register('task',{create:options=>new TmdbUpcomingEpisodesTaskWorker({...options,maintenance,configuration})});
    }
  }};
}
