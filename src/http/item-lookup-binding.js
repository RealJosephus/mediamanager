import { BindingError } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';

const lookupKinds = { Movie: 'MovieInfo', Trailer: 'TrailerInfo', MusicVideo: 'MusicVideoInfo', Series: 'SeriesInfo',
  BoxSet: 'BoxSetInfo', MusicArtist: 'ArtistInfo', MusicAlbum: 'AlbumInfo', Person: 'PersonLookupInfo', Book: 'BookInfo' };
export const remoteSearchTypes = Object.keys(lookupKinds);
const string = { type: 'string', nullable: true, clrType: 'System.String' };
const integer = { type: 'integer', nullable: true, clrType: 'System.Int32' };
const date = { type: 'datetime', nullable: true, clrType: 'System.DateTime' };
const boolean = { type: 'boolean', clrType: 'System.Boolean' };
const guid = { type: 'guid', clrType: 'System.Guid' };
const dictionary = { type: 'dictionary', nullable: true, clrType: 'System.Collections.Generic.Dictionary`2[System.String,System.String]', item: string };
const strings = { type: 'array', nullable: true, clrType: 'System.Collections.Generic.IReadOnlyList`1[System.String]', item: string };
const object = (reference, clrType) => ({ type: 'object', nullable: true, reference, clrType });
const song = object('song', 'MediaBrowser.Controller.Providers.SongInfo');
const songs = { type: 'array', nullable: true, clrType: 'System.Collections.Generic.List`1[MediaBrowser.Controller.Providers.SongInfo]', item: song };
const result = object('result', 'MediaBrowser.Model.Providers.RemoteSearchResult');
const lookupDefaults = { ProviderIds: {}, IsAutomated: true };
const lookupFields = { Name: string, OriginalTitle: string, Path: string, MetadataLanguage: string, MetadataCountryCode: string,
  ProviderIds: dictionary, Year: integer, IndexNumber: integer, ParentIndexNumber: integer, PremiereDate: date, IsAutomated: boolean };
const specialFields = {
  MusicVideo: { Artists: strings },
  MusicArtist: { SongInfos: songs },
  MusicAlbum: { SongInfos: songs, ArtistProviderIds: dictionary, AlbumArtists: strings },
  Book: { SeriesName: string },
};
const specialDefaults = { MusicArtist: { SongInfos: [] }, MusicAlbum: { SongInfos: [], ArtistProviderIds: {}, AlbumArtists: [] } };
const definitions = {
  song: { defaults: { ...lookupDefaults, Artists: [], AlbumArtists: [] },
    fields: { ...lookupFields, Album: string, Artists: strings, AlbumArtists: strings } },
  result: { defaults: { ProviderIds: {}, Artists: [] }, required: ['ProviderIds', 'Artists'],
    fields: { Name: string, ProviderIds: dictionary, ProductionYear: integer, IndexNumber: integer, IndexNumberEnd: integer,
      ParentIndexNumber: integer, PremiereDate: date, ImageUrl: string, SearchProviderName: string, Overview: string,
      AlbumArtist: result, Artists: { type: 'array', nullable: true, clrType: 'MediaBrowser.Model.Providers.RemoteSearchResult[]', item: result } } },
};

function nativeDictionaries(model) {
  if (model instanceof Map) return Object.fromEntries(model);
  if (Array.isArray(model)) return model.map(nativeDictionaries);
  if (model && typeof model === 'object') return Object.fromEntries(Object.entries(model).map(([key, value]) => [key, nativeDictionaries(value)]));
  return model;
}

function bind(body, source, root, schema, name) {
  const bound = bindJsonModel(body, { schema, root, source });
  if (bound == null) throw new BindingError(name, `The ${name} field is required.`);
  return nativeDictionaries(validateJsonModel(bound, { schema, root }));
}

export function remoteSearchBinding(type) {
  const lookup = object('lookup', 'MediaBrowser.Controller.Providers.' + lookupKinds[type]);
  const query = object('query', 'MediaBrowser.Controller.Providers.RemoteSearchQuery`1[' + lookup.clrType + ']');
  const schema = { definitions: { ...definitions,
    lookup: { defaults: { ...lookupDefaults, ...specialDefaults[type] }, fields: { ...lookupFields, ...specialFields[type] } },
    query: { defaults: { IncludeDisabledProviders: false, ItemId: null }, fields: {
      SearchInfo: lookup, ItemId: guid, SearchProviderName: string, IncludeDisabledProviders: boolean,
    } },
  } };
  return { bindBody: (body, source) => bind(body, source, query, schema, 'query'), bodyType: query.clrType };
}

export const bindSearchResult = (body, source) => bind(body, source, result, { definitions }, 'searchResult');
