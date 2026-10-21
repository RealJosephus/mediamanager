import { createHash } from 'node:crypto';
import { booleanValue, noContent, queryValue } from './binding.js';
import { BinaryResult } from './binary-result.js';
import { bindListingsProviderInfo, bindSetChannelMapping, bindTunerHostInfo } from './live-tv-source-binding.js';
import { defaultListingsProviderInfo } from '../library/live-tv-sources-service.js';
import { clrTrim } from '../metadata/whitespace.js';

export function registerLiveTvSourceRoutes(add, { liveTvSources }) {
  if (!liveTvSources) return;
  const elevated = { policy: 'RequiresElevation' }, access = { policy: 'LiveTvAccess' };
  const query = (context, name) => queryValue(context.query, name);
  const nullable = (context, name) => { const value = query(context, name); return value == null || clrTrim(value) === '' ? null : value; };
  add('POST', '/LiveTv/TunerHosts', context => liveTvSources.saveTunerHost(context.body), {
    ...elevated, body: true, bindBody: bindTunerHostInfo, bodyParameter: 'tunerHostInfo',
  });
  add('DELETE', '/LiveTv/TunerHosts', async context => { await liveTvSources.deleteTunerHost(nullable(context, 'id')); return noContent(); }, elevated);
  add('GET', '/LiveTv/TunerHosts/Types', () => liveTvSources.getTunerHostTypes(), access);
  for (const route of ['/LiveTv/Tuners/Discover', '/LiveTv/Tuners/Discvover']) add('GET', route,
    context => liveTvSources.discoverTuners(booleanValue(query(context, 'newDevicesOnly'), 'newDevicesOnly', false)), elevated);
  add('GET', '/LiveTv/ListingProviders/Default', () => defaultListingsProviderInfo(), access);
  add('POST', '/LiveTv/ListingProviders', context => {
    const password = nullable(context, 'pw');
    if (password !== null) context.body.Password = createHash('sha1').update(password, 'utf8').digest('hex');
    return liveTvSources.saveListingProvider(context.body, {
      validateListings: booleanValue(query(context, 'validateListings'), 'validateListings', false),
      validateLogin: booleanValue(query(context, 'validateLogin'), 'validateLogin', false),
    });
  }, { ...elevated, body: true, bindBody: bindListingsProviderInfo, bodyParameter: 'listingsProviderInfo' });
  add('DELETE', '/LiveTv/ListingProviders', async context => { await liveTvSources.deleteListingsProvider(nullable(context, 'id')); return noContent(); }, elevated);
  add('GET', '/LiveTv/ListingProviders/Lineups', context => liveTvSources.getLineups({ type: nullable(context, 'type'),
    id: nullable(context, 'id'), location: nullable(context, 'location'), country: nullable(context, 'country') }), access);
  add('GET', '/LiveTv/ListingProviders/SchedulesDirect/Countries', async () => {
    const bytes = await liveTvSources.getCountries();
    return BinaryResult.bytes(bytes, 'application/json');
  }, elevated);
  add('GET', '/LiveTv/ChannelMappingOptions', context => liveTvSources.getChannelMappingOptions(nullable(context, 'providerId')), elevated);
  add('POST', '/LiveTv/ChannelMappings', context => liveTvSources.setChannelMapping(context.body.ProviderId,
    context.body.TunerChannelId, context.body.ProviderChannelId), { ...elevated, body: true, bindBody: bindSetChannelMapping, bodyParameter: 'dto' });
}
