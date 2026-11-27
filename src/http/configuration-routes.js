import { httpError, noContent } from './binding.js';
import { bindLiveTvConfiguration } from './live-tv-configuration-binding.js';
import { bindServerConfiguration, defaultMetadataOptions, serverConfigurationDto } from './server-configuration-binding.js';
import { namedConfigurationBody, namedConfigurationDto } from './named-configuration-binding.js';
import { namedConfigurationRoots } from '../core/named-configuration-store.js';

export function registerConfigurationRoutes(add, services) {
  const { configurationStore, liveTv, namedConfiguration } = services;
  // The controller's default authorization also applies to elevated actions.
  const elevated = ['Default', 'RequiresElevation'];
  // ConfigurationController.GetConfiguration uses ordinary authentication.
  // Runtime-only network/path helpers do not belong to ServerConfiguration.
  add('GET', '/System/Configuration', () => serverConfigurationDto(services.configuration));
  add('POST', '/System/Configuration', async context => {
    if (!configurationStore) throw httpError(503, 'Server configuration persistence is unavailable.');
    await configurationStore.replaceConfiguration(context.body);
    return noContent();
  }, { policy: elevated, body: true, bodyParameter: 'configuration',
    bodyType: 'MediaBrowser.Model.Configuration.ServerConfigurationDto', bindBody: bindServerConfiguration });
  add('GET', '/System/Configuration/MetadataOptions/Default', defaultMetadataOptions, { policy: elevated });
  if (liveTv) {
    add('GET', '/System/Configuration/LiveTv', () => liveTv.getConfiguration());
    add('POST', '/System/Configuration/LiveTv', async context => {
      await liveTv.saveConfiguration(context.body);
      return noContent();
    }, { policy: elevated, body: true, bodyParameter: 'configuration',
      bodyType: 'MediaBrowser.Model.LiveTv.LiveTvOptionsDto', bindBody: bindLiveTvConfiguration });
  }
  if (namedConfiguration) {
    for (const key of namedConfigurationRoots) {
      const route = '/System/Configuration/' + key;
      add('GET', route, async () => namedConfigurationDto(key, await namedConfiguration.getConfiguration(key)));
      add('POST', route, async ({ body }) => {
        await namedConfiguration.saveConfiguration(key, body);
        return noContent();
      }, { policy: elevated, ...namedConfigurationBody(key) });
    }
  }
}
