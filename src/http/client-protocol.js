import { BinaryResult } from './binary-result.js';

export function embyTextResponse(status, text) {
  const result = BinaryResult.bytes(Buffer.from(text), 'text/plain');
  return new BinaryResult((request, response) => {
    response.statusCode = status;
    return result.send(request, response);
  });
}

export function isEmbyClient(authentication, context) {
  const declared = authentication.read?.(context.request)?.Client || context.request.headers['x-emby-client'];
  const client = String(declared || context.auth.Client || '');
  if (/jellyfin/iu.test(client)) return false;
  const authorization = context.request.headers.authorization || context.request.headers['x-emby-authorization'] || '';
  return /emby/iu.test(client) || Boolean(context.embyPath) || /^Emby(?:\s|$)/iu.test(authorization);
}
