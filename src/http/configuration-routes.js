import { httpError, noContent } from './binding.js';
import { bindLiveTvConfigurationDocument, deserializeLiveTvConfiguration } from './live-tv-configuration-binding.js';
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
    add('GET', '/System/Configuration/{key}', context => liveTv.getConfiguration(context.params.key), {
      constraints: { key: value => /^livetv$/iu.test(value) }
    });
    add('POST', '/System/Configuration/{key}', async context => {
      await liveTv.saveConfiguration(deserializeLiveTvConfiguration(context.body), context.params.key);
      return noContent();
    }, { policy: elevated, body: true, bodyDocument: true, bodyParameter: 'configuration', bindBody: bindLiveTvConfigurationDocument,
      constraints: { key: value => /^livetv$/iu.test(value) } });
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
