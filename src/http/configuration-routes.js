import model from '../core/resources/configuration-model.json' with { type: 'json' };
import { defaultConfiguration } from '../core/configuration-xml.js';

const serverFields = Object.keys(model.definitions.ServerConfiguration.fields);

export function registerConfigurationRoutes(add, { configuration }) {
  // ConfigurationController.GetConfiguration uses ordinary authentication.
  // Runtime-only network/path helpers do not belong to ServerConfiguration.
  add('GET', '/System/Configuration', () => {
    const defaults = defaultConfiguration('server');
    return Object.fromEntries(serverFields.map(name => [name,
      Object.hasOwn(configuration, name) ? configuration[name] : defaults[name]]));
  });
}
