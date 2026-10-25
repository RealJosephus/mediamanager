import { httpError, noContent } from './binding.js';
import { bindLiveTvConfigurationDocument, deserializeLiveTvConfiguration } from './live-tv-configuration-binding.js';
import { bindServerConfiguration, defaultMetadataOptions, serverConfigurationDto } from './server-configuration-binding.js';
import { bindNamedConfigurationDocument, deserializeNamedConfiguration } from './named-configuration-binding.js';

export function registerConfigurationRoutes(add, services) {
  const { configurationStore, liveTv, namedConfiguration } = services;
  // ConfigurationController.GetConfiguration uses ordinary authentication.
  // Runtime-only network/path helpers do not belong to ServerConfiguration.
  add('GET', '/System/Configuration', () => serverConfigurationDto(services.configuration));
  add('POST', '/System/Configuration', async context => {
    if (!configurationStore) throw httpError(503, 'Server configuration persistence is unavailable.');
    await configurationStore.replaceConfiguration(context.body);
    return noContent();
  }, { policy: 'RequiresElevation', body: true, bodyParameter: 'configuration',
    bodyType: 'MediaBrowser.Model.Configuration.ServerConfiguration', bindBody: bindServerConfiguration });
  add('GET', '/System/Configuration/MetadataOptions/Default', defaultMetadataOptions, { policy: 'RequiresElevation' });
  if (liveTv) {
    add('GET', '/System/Configuration/{key}', context => liveTv.getConfiguration(context.params.key), {
      constraints: { key: value => /^livetv$/iu.test(value) }
    });
    add('POST', '/System/Configuration/{key}', async context => {
      await liveTv.saveConfiguration(deserializeLiveTvConfiguration(context.body), context.params.key);
      return noContent();
    }, { policy: 'RequiresElevation', body: true, bodyDocument: true, bodyParameter: 'configuration', bindBody: bindLiveTvConfigurationDocument,
      constraints: { key: value => /^livetv$/iu.test(value) } });
  }
  if (namedConfiguration) {
    const constraints = { key: value => !/^(?:livetv|branding)$/iu.test(value) };
    add('GET', '/System/Configuration/{key}', context => namedConfiguration.getConfiguration(context.params.key), { constraints });
    add('POST', '/System/Configuration/{key}', async context => {
      await namedConfiguration.saveConfiguration(context.params.key, deserializeNamedConfiguration(context.params.key, context.body));
      return noContent();
    }, { policy: 'RequiresElevation', body: true, bodyDocument: true, bodyParameter: 'configuration',
      bindBody: bindNamedConfigurationDocument, constraints });
  }
}
