import { createSchedulesDirectProvider } from './provider.js';

export async function activate(context) {
  let provider;
  return { async connect(services) {
    if (provider) return;
    provider = createSchedulesDirectProvider({
      ...context.options, get cachePath() { return context.paths.cachePath ?? context.cachePath; },
      fileSystem: services.fileSystem, imagePolicy: services.liveTvCountries,
      userAgent: 'MediaManager/' + services.serverVersion,
    });
    await context.register('listings', provider);
  } };
}
