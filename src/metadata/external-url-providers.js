import { MetadataRegistry } from './registry.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

const providerId = (item, key) => Object.entries(item.ProviderIds ?? {}).find(([name]) => ordinalIgnoreCaseEquals(name, key))?.[1];
export function createBuiltinExternalUrlPlugin() {
  const rows = [
    ['ComicVine','Comic Vine','https://comicvine.gamespot.com/',['Person','Book']],
    ['GoogleBooks','Google Books','https://books.google.com/books?id=',['Book']],
    ['ISBN','ISBN','https://search.worldcat.org/search?q=bn:',['Book']],
    ['MusicBrainzAlbum','MusicBrainz Album','/release/',['MusicAlbum']],
    ['MusicBrainzAlbumArtist','MusicBrainz Album Artist','/artist/',['MusicAlbum']],
    ['MusicBrainzArtist','MusicBrainz Artist','/artist/',['MusicArtist','Person']],
    ['MusicBrainzReleaseGroup','MusicBrainz Release Group','/release-group/',['MusicAlbum']],
    ['MusicBrainzTrack','MusicBrainz Track','/track/',['Audio','AudioBook']],
    ['AudioDbAlbum','TheAudioDb Album','https://www.theaudiodb.com/album/',['MusicAlbum']],
    ['AudioDbArtist','TheAudioDb Artist','https://www.theaudiodb.com/artist/',['MusicArtist','Person']],
    ['Zap2It','Zap2It','http://tvlistings.zap2it.com/overview.html?programSeriesId=',['*']],
  ];
  const providers = rows.map(([key,name,base,itemTypes]) => ({ id: key+'ExternalUrlProvider', name, kind:'externalUrl', itemTypes,
    getExternalUrls(item,{musicBrainzServer='https://musicbrainz.org'}={}) {
      const id=providerId(item,key);return id ? [(base.startsWith('/') ? musicBrainzServer.replace(/\/+$/,'')+base : base)+id] : [];
    } }));
  providers.push({id:'ImdbExternalUrlProvider',name:'IMDb',kind:'externalUrl',itemTypes:['*'],getExternalUrls(item){
    const seriesId=providerId({ProviderIds:item.SeriesProviderIds},'Imdb');
    if(item.Type==='Season')return seriesId && item.IndexNumber!=null
      ? [`https://www.imdb.com/title/${seriesId}/episodes/?season=${item.IndexNumber}`] : [];
    const id=providerId(item,'Imdb');return id ? [`https://www.imdb.com/${item.Type==='Person'?'name':'title'}/${id}`] : [];
  }});
  return {id:'builtin-external-urls',name:'External identifiers',providers};
}

export function createExternalUrlRegistry() {
  const registry=new MetadataRegistry();
  registry.register(createBuiltinExternalUrlPlugin());
  return registry;
}
