function urlDecode(value) {
  // URLSearchParams follows form-url-encoded '+' and invalid UTF-8 replacement rules.
  return new URLSearchParams(`value=${value.replaceAll('&', '%26').replaceAll('#', '%23')}`).get('value');
}

export function parseAuthorizationParts(value) {
  const result = Object.create(null);
  let escaped = false;
  let start = 0;
  let key = '';
  let i;
  for (i = 0; i < value.length; i++) {
    const token = value[i];
    if (token === '"' || token === ',') {
      escaped = (!escaped) === (token === '"');
      if (token === ',' && !escaped) {
        if (start < i) { result[key] = urlDecode(value.slice(start, i).replace(/^"+|"+$/g, '')); key = ''; }
        start = i + 1;
      }
    } else if (!escaped && token === '=') { key = value.slice(start, i).trim(); start = i + 1; }
  }
  if (start < i) result[key] = urlDecode(value.slice(start, i).replace(/^"+|"+$/g, ''));
  return result;
}

export function readAuthorization(request, { enableLegacyAuthorization = false } = {}) {
  const headers = new Headers(request.headers);
  const query = request.query instanceof URLSearchParams ? request.query : new URL(request.url, 'http://localhost').searchParams;
  const queryValue = name => [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value).join(',');
  let raw = headers.get('Authorization');
  if (enableLegacyAuthorization && !raw) raw = headers.get('X-Emby-Authorization');
  let parts = Object.create(null);
  const space = raw?.indexOf(' ') ?? -1;
  if (space !== -1) {
    const scheme = raw.slice(0, space).toLowerCase();
    if (scheme === 'mediabrowser' || (enableLegacyAuthorization && scheme === 'emby')) parts = parseAuthorizationParts(raw.slice(space + 1));
  }
  const info = { Client: parts.Client ?? null, Device: parts.Device ?? null,
    DeviceId: parts.DeviceId ?? null, Version: parts.Version ?? null, Token: parts.Token ?? null, IsAuthenticated: false };
  if (enableLegacyAuthorization) {
    for (const [field, key] of Object.entries({ Client: 'X-Emby-Client', Device: 'X-Emby-Device-Name',
      DeviceId: 'X-Emby-Device-Id', Version: 'X-Emby-Client-Version', Token: 'X-Emby-Token' })) {
      if (!info[field]) info[field] = queryValue(key);
    }
    if (!info.Token) info.Token = headers.get('X-Emby-Token') ?? '';
    if (!info.Token) info.Token = headers.get('X-MediaBrowser-Token') ?? '';
  }
  if (!info.Token) info.Token = queryValue('ApiKey');
  if (enableLegacyAuthorization && !info.Token) info.Token = queryValue('api_key');
  return info;
}
