import { lowerInvariant } from '../core/identity.js';

// Jellyfin.Server.Configuration.CorsPolicyProvider and ASP.NET Core CORS:
// configured origins are exact browser origins, never suffix/wildcard matches.
function normalizeOrigin(origin) {
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(origin)?.[1];
  if (authority && /[^\x00-\x7f]/u.test(authority.split('@').at(-1))) {
    try { return new URL(origin).origin; } catch { /* Invalid origins remain exact values. */ }
  }
  return lowerInvariant(origin);
}

export function applyCors(request, response, configuration) {
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  const hosts = configuration.CorsHosts === undefined ? ['*'] : configuration.CorsHosts;
  const anyOrigin = hosts.length === 0 || hosts.length === 1 && hosts[0] === '*';
  const preflight = request.method === 'OPTIONS' && Object.hasOwn(request.headers, 'access-control-request-method');
  if (origin && (anyOrigin || hosts.map(normalizeOrigin).includes(origin))) {
    response.setHeader('Access-Control-Allow-Origin', anyOrigin ? '*' : origin);
    if (!anyOrigin) response.setHeader('Access-Control-Allow-Credentials', 'true');
    if (preflight) {
      const method = request.headers['access-control-request-method'];
      if (method) response.setHeader('Access-Control-Allow-Methods', method);
      const headers = request.headers['access-control-request-headers']?.split(',').map(value => value.trim()).filter(Boolean);
      if (headers?.length) response.setHeader('Access-Control-Allow-Headers', headers.join(','));
    }
    if (!anyOrigin && hosts.length > 1) {
      response.appendHeader('Vary', 'Origin');
    }
  }
  // The CORS middleware terminates every preflight, including denied origins;
  // absence of allow headers tells the browser to reject the actual request.
  if (preflight) {
    response.removeHeader('Content-Language');
    response.statusCode = 204;
    response.end();
  }
  return preflight;
}
