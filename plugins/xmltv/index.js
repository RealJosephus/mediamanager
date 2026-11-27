import path from 'node:path';
import { createXmlTvListingsProvider, xmlTvCacheFile } from './provider.js';

const cacheDirectory = context => context.options.cachePath ?? path.join(context.paths.cachePath ?? context.cachePath, 'xmltv');

export async function clearCache(context, services) {
  if (!services?.liveTvSources) return;
  const root = cacheDirectory(context), files = context.options.fileSystem ?? services.fileSystem;
  await services.liveTvSources.clearListingsCache('xmltv', async id => {
    const cached = xmlTvCacheFile(root, id);
    for (const filename of [cached, cached + '.tmp']) {
      try { await files.unlink(filename); }
      catch (error) { if (!['ENOENT', 'not-found'].includes(error.code)) throw error; }
    }
  });
}

export function validateConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || Object.keys(configuration).length) {
    throw new TypeError('XMLTV settings belong to each native listings provider configuration.');
  }
}

export async function activate(context) {
  validateConfiguration(context.getConfiguration());
  let provider;
  return { configuration: {}, fields: {}, async connect(services) {
    if (provider) return;
    const { metadataVfs, metadataIdentityMap } = services;
    const mapped = identity => {
      if (!metadataVfs || !metadataIdentityMap) throw Object.assign(new Error('The XMLTV local source has no storage mapping.'), { code: 'unmapped-path' });
      return metadataIdentityMap.resolve({ identityPath: identity });
    };
    const options = Object.create(context.options, {
      cachePath: { get: () => cacheDirectory(context) },
      logger: { get: () => context.options.logger ?? context.logger },
      fileSystem: { get: () => context.options.fileSystem ?? services.fileSystem },
      preferredMetadataLanguage: { value: () => services.configuration === undefined ? 'en' : services.configuration.PreferredMetadataLanguage },
      source: { value: {
        stat: (identity, options) => { const location = mapped(identity); return metadataVfs.stat(location, options); },
        openRead: (identity, options) => { const location = mapped(identity); return metadataVfs.openRead(location, options); },
      } },
    });
    provider = createXmlTvListingsProvider(options);
    await context.register('listings', provider);
  }, close: () => provider?.close() };
}
