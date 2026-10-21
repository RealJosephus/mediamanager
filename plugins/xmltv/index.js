import path from 'node:path';
import { createXmlTvListingsProvider } from './provider.js';

export function validateConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || Object.keys(configuration).length) {
    throw new TypeError('XMLTV settings belong to each native listings provider configuration.');
  }
}

export async function activate(context) {
  validateConfiguration(context.configuration);
  let provider;
  return { configuration: {}, fields: {}, async connect(services) {
    if (provider) return;
    const { metadataVfs, metadataIdentityMap, configuration } = services;
    const mapped = identity => {
      if (!metadataVfs || !metadataIdentityMap) throw Object.assign(new Error('The XMLTV local source has no storage mapping.'), { code: 'unmapped-path' });
      return metadataIdentityMap.resolve({ identityPath: identity, style: /^[A-Za-z]:[\\/]|^\\\\/u.test(identity) ? 'windows' : 'posix' });
    };
    provider = createXmlTvListingsProvider({ ...context.options, cachePath: path.join(context.paths.cachePath ?? context.cachePath, 'xmltv'), logger: context.logger,
      preferredMetadataLanguage: () => configuration === undefined ? 'en' : configuration.PreferredMetadataLanguage, source: {
        stat: (identity, options) => { const location = mapped(identity); return metadataVfs.stat(location, options); },
        openRead: (identity, options) => { const location = mapped(identity); return metadataVfs.openRead(location, options); },
      } });
    await context.register('listings', provider);
  }, close: () => provider?.close() };
}
