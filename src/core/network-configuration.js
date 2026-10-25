import { clrTrim } from '../metadata/whitespace.js';
import model from './resources/configuration-model.json' with { type: 'json' };

const configured = new WeakSet();

// Install before assigning XML/JSON fields. A second visit to the same value
// must not remove a second trailing slash from an already assigned BaseUrl.
export function networkConfigurationBaseUrl(configuration) {
  if (configured.has(configuration)) return configuration;
  for (const [name, value] of Object.entries(model.definitions.NetworkConfiguration.defaults)) {
    if (!Object.hasOwn(configuration, name)) configuration[name] = structuredClone(value);
  }
  const initial = configuration.BaseUrl;
  let baseUrl = '';
  Object.defineProperty(configuration, 'BaseUrl', {
    enumerable: true, configurable: true,
    get: () => baseUrl,
    set(value) {
      if (value == null || clrTrim(value) === '') { baseUrl = ''; return; }
      if (typeof value !== 'string') throw new TypeError('BaseUrl must be a string or null.');
      baseUrl = value.startsWith('/') ? value : '/' + value;
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    },
  });
  configured.add(configuration);
  configuration.BaseUrl = initial;
  return configuration;
}
