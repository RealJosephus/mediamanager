import { connectionAddress, networkAddress } from '../users/network.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { validateHeaderValue } from 'node:http';

export function requestNetworkInfo(request) {
  const local = request.socket?.localAddress, remote = request.socket?.remoteAddress;
  return { remoteEndPoint: networkAddress(remote ?? '') ?? '127.0.0.1',
    localAddress: local == null ? null : connectionAddress(local),
    isLocal: local == null && remote == null || local != null && remote != null && connectionAddress(local) === connectionAddress(remote),
    scheme: request.socket?.encrypted ? 'https' : 'http', host: request.headers.host ?? 'localhost' };
}

export function requestIsLocal(info) {
  return info.isLocal ?? (info.localAddress == null && !info.remoteEndPoint || info.localAddress === info.remoteEndPoint);
}

export function requestUrl(request) {
  const source = request.url ?? '/';
  const origin = (request.socket?.encrypted ? 'https://' : 'http://') + (request.headers.host ?? 'localhost');
  if (!source.startsWith('/')) return new URL(source, origin);
  // Origin-form can begin with several slashes. URL(source, origin) would
  // reinterpret them as an authority and silently remove part of the path.
  const result = new URL(origin), query = source.indexOf('?');
  result.pathname = query < 0 ? source : source.slice(0, query);
  result.search = query < 0 ? '' : source.slice(query);
  return result;
}

export function requestPath(request) {
  const encoded = requestUrl(request).pathname;
  try { return decodeURIComponent(encoded.replace(/%2f/giu, value => '%25' + value.slice(1))); }
  catch { return encoded; }
}

// This runs before forwarded headers, as BaseUrlRedirectionMiddleware does.
export function baseUrlRedirect(request, prefix, defaultPath = 'web/') {
  const url = requestUrl(request);
  // The redirect middleware compares the URI form of the path. Routing and
  // Map use its decoded form instead, so Unicode prefixes can still redirect.
  const local = requestPath(request).replace(/%[0-9a-f]{2}|[^!$&'()*+,\-./0-9:;=@A-Z_a-z~]/giu,
    value => /^%[0-9a-f]{2}$/iu.test(value) ? value : encodeURIComponent(value));
  const location = value => {
    validateHeaderValue('Location', value);
    if (/[^\x09\x20-\x7e]/u.test(value)) throw Object.assign(new TypeError('The redirect Location contains a non-ASCII header character.'), { code: 'invalid-response-header' });
    return value;
  };
  if (local && !ordinalIgnoreCaseEquals(local, prefix) && !ordinalIgnoreCaseEquals(local, prefix + '/')
    && ordinalIgnoreCaseEquals(local.slice(0, prefix.length), prefix)) return null;
  if (ordinalIgnoreCaseEquals(local, '/health') || ordinalIgnoreCaseEquals(local, '/health/')) return location(prefix + '/health');
  const target = new URL(url.origin);
  target.pathname = prefix + '/' + defaultPath;
  const parent = url.pathname.split('/'); parent.pop();
  const destination = target.pathname.split('/');
  let common = 0;
  while (common < parent.length && common < destination.length && parent[common] === destination[common]) common += 1;
  let relative = '../'.repeat(parent.length - common) + destination.slice(common).join('/');
  if (relative.startsWith('/') || relative.split('/')[0].includes(':')) relative = './' + relative;
  return location(decodeURI(relative || './'));
}
