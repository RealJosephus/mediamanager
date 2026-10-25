import { parseConfigurationVersion } from './configuration-xml.js';

export function configurationVersionAliases(configuration) {
  let version = parseConfigurationVersion(Object.hasOwn(configuration, 'PreviousVersion')
    ? configuration.PreviousVersion : configuration.PreviousVersionStr);
  Object.defineProperties(configuration, {
    PreviousVersion: { enumerable: true, configurable: true, get: () => version, set(value) {
      const parsed = value === null ? null : parseConfigurationVersion(value);
      if (value !== null && parsed === null) throw Object.assign(new TypeError('A valid previous version or null is required.'), { code: 'invalid-configuration-value' });
      version = parsed;
    } },
    PreviousVersionStr: { enumerable: true, configurable: true, get: () => version, set(value) {
      const parsed = parseConfigurationVersion(value);
      if (parsed !== null) version = parsed;
    } },
  });
  return configuration;
}
