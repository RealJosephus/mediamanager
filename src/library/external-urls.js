import { createExternalUrlRegistry } from '../metadata/external-url-providers.js';
import { idKey, nonemptyId } from './records.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export async function loadExternalUrlConfiguration({ programDataPath, onError = () => {} } = {}) {
  const defaults = { musicBrainzServer: 'https://musicbrainz.org' };
  if (!programDataPath) return defaults;
  try {
    const xml = await readFile(path.join(programDataPath, 'plugins', 'configurations', 'Jellyfin.Plugin.MusicBrainz.xml'), 'utf8');
    if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid native MusicBrainz configuration XML.');
    const node = new XMLParser({ parseTagValue: false, trimValues: false }).parse(xml).PluginConfiguration;
    if (node == null) throw new Error('Missing native MusicBrainz configuration root.');
    if (node.Server == null) return defaults;
    if (typeof node.Server !== 'string') throw new Error('Invalid native MusicBrainz server value.');
    return { musicBrainzServer: node.Server.replace(/\/+$/, '') };
  } catch (error) { if (error.code !== 'ENOENT') onError(error); return defaults; }
}

export function externalUrlContext(item, state) {
  const parents = state.ancestors(item);
  const series = nonemptyId(item.SeriesId) ? state.byId.get(idKey(item.SeriesId)) : parents.find(parent => parent.Type === 'Series');
  const season = nonemptyId(item.SeasonId) ? state.byId.get(idKey(item.SeasonId)) : parents.find(parent => parent.Type === 'Season')
    ?? (series && item.ParentIndexNumber != null ? state.children(series).find(child => child.Type === 'Season' && child.IndexNumber === item.ParentIndexNumber) : undefined);
  return { ...item, ProviderIds: item.ProviderIds,
    SeriesProviderIds: series?.Type === 'Series' ? series.ProviderIds : undefined,
    SeriesDisplayOrder: series?.Type === 'Series' ? series.DisplayOrder : undefined,
    SeasonIndexNumber: season?.Type === 'Season' ? season.IndexNumber : undefined };
}

export function projectExternalUrls(item, state, { externalUrlRegistry = createExternalUrlRegistry(), musicBrainzServer = 'https://musicbrainz.org' } = {}) {
  item = externalUrlContext(item, state);
  return externalUrlRegistry.discover({item,kind:'externalUrl'}).sort((a,b)=>a.name.localeCompare(b.name))
    .flatMap(provider => provider.getExternalUrls(item,{musicBrainzServer}).map(Url=>({Name:provider.name,Url})));
}
