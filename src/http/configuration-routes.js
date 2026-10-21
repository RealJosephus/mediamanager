import model from '../core/resources/configuration-model.json' with { type: 'json' };
import { defaultConfiguration } from '../core/configuration-xml.js';
import { noContent } from './binding.js';
import { bindLiveTvConfigurationDocument, deserializeLiveTvConfiguration } from './live-tv-configuration-binding.js';

const serverFields = Object.keys(model.definitions.ServerConfiguration.fields);

export function registerConfigurationRoutes(add, { configuration, liveTv }) {
  // ConfigurationController.GetConfiguration uses ordinary authentication.
  // Runtime-only network/path helpers do not belong to ServerConfiguration.
  add('GET', '/System/Configuration', () => {
    const defaults = defaultConfiguration('server');
    return Object.fromEntries(serverFields.map(name => [name,
      Object.hasOwn(configuration, name) ? configuration[name] : defaults[name]]));
  });
  if (liveTv) {
    add('GET', '/System/Configuration/{key}', context => liveTv.getConfiguration(context.params.key), {
      constraints: { key: value => /^livetv$/iu.test(value) }
    });
    add('POST', '/System/Configuration/{key}', async context => {
      await liveTv.saveConfiguration(deserializeLiveTvConfiguration(context.body), context.params.key);
      return noContent();
    }, { policy: 'RequiresElevation', body: true, bodyParameter: 'configuration', bindBody: bindLiveTvConfigurationDocument,
      constraints: { key: value => /^livetv$/iu.test(value) } });
  }
}
