import { HttpResult } from './binding.js';
import { maximumClientLogBytes, writeClientLog } from '../system/client-log.js';

export function registerClientLogRoutes(add, services, localization) {
  add('POST', '/ClientLog/Document', async context => {
    if (!services.configuration.AllowClientLogUpload) return new HttpResult(403);
    const declared = context.request.headers['content-length'];
    if (declared !== undefined && BigInt(declared) > BigInt(maximumClientLogBytes)) {
      const limit = new Intl.NumberFormat(localization.context.culture).format(maximumClientLogBytes);
      return new HttpResult(413, `Payload must be less than ${limit} bytes`);
    }
    const stopBody = () => context.request.destroy();
    context.signal?.addEventListener('abort', stopBody, { once: true });
    try {
      if (context.signal?.aborted) stopBody();
      const FileName = await writeClientLog({ directory: services.applicationPaths?.logDirectoryPath,
        clientName: context.auth.Client ?? 'unknown-client',
        clientVersion: context.auth.IsApiKey ? 'apikey' : context.auth.Version ?? 'unknown-version', source: context.request });
      return { FileName };
    } finally { context.signal?.removeEventListener('abort', stopBody); }
  });
}
