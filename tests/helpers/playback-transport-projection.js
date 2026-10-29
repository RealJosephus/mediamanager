import assert from 'node:assert/strict';
import { projectPlaybackInfoBody } from './http-body-projection.js';

export function projectPlaybackRequestUrl(value, { token, playSessionId }) {
  return value.replace(/([?&])(api_key|ApiKey|PlaySessionId)=([^&#\r\n]*)/gu, (_match, separator, name, encoded) => {
    const credential = name === 'api_key' || name === 'ApiKey';
    const actual = decodeURIComponent(encoded);
    assert.ok(typeof actual === 'string' && actual.length > 0, 'A playback URL identity must be present.');
    assert.ok(actual === (credential ? token : playSessionId), 'A playback URL must use its admitted credential and session.');
    return separator + name + '=' + (credential ? '<token>' : '<session>');
  });
}

export function projectPlaybackTransportBody(body, { status, token, path } = {}) {
  const projected = projectPlaybackInfoBody(body, { status, path });
  if (status !== 200 || !projected || !Array.isArray(projected.MediaSources)) return projected;
  const identities = { token, playSessionId: body.PlaySessionId };
  const delivery = stream => stream && typeof stream === 'object' && typeof stream.DeliveryUrl === 'string'
    ? { ...stream, DeliveryUrl: projectPlaybackRequestUrl(stream.DeliveryUrl, identities) } : stream;
  projected.MediaSources = projected.MediaSources.map(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
    const result = typeof source.TranscodingUrl === 'string'
      ? { ...source, TranscodingUrl: projectPlaybackRequestUrl(source.TranscodingUrl, identities) } : source;
    return Array.isArray(result.MediaStreams) ? { ...result, MediaStreams: result.MediaStreams.map(delivery) } : result;
  });
  return projected;
}

// These finite historical transport captures omit the root session field.
// Validate the live correlation before omitting only that root from their
// summary. Complete PlaybackInfo wire comparisons retain its field presence.
export function playbackTransportSummary(body, token) {
  const projected = projectPlaybackTransportBody(body, { status: 200, token });
  if (!projected || !Array.isArray(projected.MediaSources)) return projected;
  if (projected.MediaSources.length) {
    assert.ok(typeof body.PlaySessionId === 'string' && body.PlaySessionId.length > 0, 'PlaybackInfo must supply its actual session.');
  }
  delete projected.PlaySessionId;
  return projected;
}

export function projectHlsRequestIdentities(text, identities) {
  return text.split(/(\r?\n)/u).map(line => {
    const trimmed = line.trimStart();
    if (trimmed && !trimmed.startsWith('#')) return projectPlaybackRequestUrl(line, identities);
    if (/^#EXT-X-(?:MEDIA|MAP|KEY|SESSION-KEY|I-FRAME-STREAM-INF):/u.test(trimmed)) {
      const separator = line.indexOf(':') + 1;
      const attributes = line.slice(separator).replace(/(^|,)([ \t]*)([^=,]+)=(?:"([^"]*)"|([^,]*))/gu,
        (match, begin, space, name, quoted) => name.trim() === 'URI' && quoted !== undefined
          ? begin + space + name + '="' + projectPlaybackRequestUrl(quoted, identities) + '"' : match);
      return line.slice(0, separator) + attributes;
    }
    return line;
  }).join('');
}
