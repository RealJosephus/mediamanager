// Method shapes follow the designated ITunerHost, IListingsProvider, IChannel
// and IRequiresMediaInfoCallback interfaces. These are Node plugin operations,
// not public HTTP DTOs or permission to run recording/transcoding executors.
export const liveTvSignalPositions = Object.freeze({
  tuner: Object.freeze({ getChannels: 1, getChannelStream: 3, getChannelStreamMediaSources: 1, discoverDevices: 1, validate: 1 }),
  listings: Object.freeze({ getPrograms: 4, validate: 3, getLineups: 3, getChannels: 1 }),
  channel: Object.freeze({ getChannelFeatures: 0, isEnabledFor: 1, getChannelItems: 1,
    getChannelImage: 1, getSupportedChannelImages: 0, getChannelItemMediaInfo: 1 }),
});
const required = {
  tuner: ['getChannels', 'getChannelStream', 'getChannelStreamMediaSources', 'discoverDevices'],
  listings: ['getPrograms', 'validate', 'getLineups', 'getChannels'],
  channel: ['getChannelFeatures', 'isEnabledFor', 'getChannelItems', 'getChannelImage', 'getSupportedChannelImages'],
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const unsupported = message => Object.assign(new Error(message), { status: 400, statusCode: 400, code: 'not-supported' });
const encodedProfile = value => /^(?:heavy|mobile|internet\d*)(?:_|$)/iu.test(value);
const executableMembers = new Set(['transcode', 'openTranscoder', 'startTranscoding', 'startRecording', 'record', 'openRecording']);

export function validateLiveTvExtension(kind, extension) {
  const methods = liveTvSignalPositions[kind];
  if (!methods || !object(extension) || !text(extension.type) || !text(extension.name)) {
    throw new TypeError('A Live TV extension requires a known kind and nonempty type and name.');
  }
  for (const method of required[kind]) if (typeof extension[method] !== 'function') {
    throw new TypeError(`The ${kind} extension requires ${method}.`);
  }
  for (const method of Object.keys(methods)) if (extension[method] !== undefined && typeof extension[method] !== 'function') {
    throw new TypeError(`The ${kind} extension method ${method} must be callable.`);
  }
  if (extension.supportsRecording === true || extension.supportsTranscoding === true) {
    throw unsupported('Live TV extensions cannot advertise recording or transcoding execution.');
  }
  if (kind === 'tuner' && extension.isSupported !== undefined && typeof extension.isSupported !== 'boolean') {
    throw new TypeError('A tuner support declaration must be boolean.');
  }
  for (const member of executableMembers) if (member in extension) {
    throw unsupported('Live TV extensions cannot register recording or transcoding executors.');
  }
  return extension;
}

/** A source declaration is separate from its untouched native MediaSourceInfo. */
export function validateNativeLiveTvSource(source) {
  if (!object(source) || source.mode !== 'native' || !object(source.mediaSource)
    || !text(source.mediaSource.Id) || !text(source.mediaSource.Path)) {
    throw unsupported('A Live TV source requires native mode and an identified original media source.');
  }
  if (source.profile !== undefined && (typeof source.profile !== 'string' || source.profile.toLowerCase() !== 'native')) {
    throw unsupported('Encoded Live TV source profiles are unavailable.');
  }
  const media = source.mediaSource;
  if (encodedProfile(media.Id) || text(media.EncoderPath) || text(media.TranscodingUrl) || text(media.TranscodingContainer)) {
    throw unsupported('Live TV sources cannot advertise an encoder or encoded output.');
  }
  // HDHomeRun uses both a profile-prefixed source identity and transcode= in
  // its HTTP input. Reject that operation itself, not just its DTO flags.
  try {
    const url = new URL(media.Path);
    for (const [key, value] of url.searchParams) if (key.toLowerCase() === 'transcode' && value && value.toLowerCase() !== 'native') {
      throw unsupported('Encoded Live TV source profiles are unavailable.');
    }
  } catch (cause) { if (cause.code === 'not-supported') throw cause; }
  return source;
}

export function validateLiveTvStreamRequest(channelId, streamId, currentLiveStreams, options) {
  if (!text(channelId) || streamId != null && typeof streamId !== 'string' || !Array.isArray(currentLiveStreams)) {
    throw new TypeError('A tuner stream requires a channel, nullable original stream identity and current live stream leases.');
  }
  validateNativeLiveTvSource(options?.source);
}

export function validateLiveTvSources(sources) {
  if (!Array.isArray(sources)) throw new TypeError('A Live TV media source operation must return an array.');
  for (const source of sources) validateNativeLiveTvSource(source);
  return sources;
}

export function validateLiveTvChannelItems(result) {
  if (!object(result) || !Array.isArray(result.Items)) throw new TypeError('A channel item operation must return Items.');
  for (const item of result.Items) {
    if (!object(item)) throw new TypeError('A channel item must be an object.');
    if (item.MediaSources !== undefined) validateLiveTvSources(item.MediaSources);
  }
  return result;
}

export function validateLiveTvChannelImage(image) {
  if (image !== null && (!object(image) || !(image.bytes instanceof Uint8Array) || !text(image.mimeType))) {
    throw new TypeError('A channel image must be null or owned bytes and a MIME type.');
  }
  return image;
}

export function validateLiveTvResult(kind, method, result) {
  if (method === 'getChannelStreamMediaSources' || method === 'getChannelItemMediaInfo') return validateLiveTvSources(result);
  if (kind === 'channel' && method === 'getChannelItems') return validateLiveTvChannelItems(result);
  if (kind === 'channel' && method === 'getChannelImage') return validateLiveTvChannelImage(result);
  if (['getChannels', 'discoverDevices', 'getPrograms', 'getLineups', 'getSupportedChannelImages'].includes(method)
    && !Array.isArray(result)) throw new TypeError('A Live TV list operation must return a finite array.');
  if (method === 'isEnabledFor' && typeof result !== 'boolean') throw new TypeError('Channel enablement must return boolean.');
  if (method === 'getChannelFeatures' && !object(result)) throw new TypeError('Channel features must be an object.');
  return result;
}

export function validateOwnedLiveTvStream(resource) {
  validateNativeLiveTvSource(resource);
  if (resource.tunerHostId !== null && typeof resource.tunerHostId !== 'string') {
    throw new TypeError('A live stream lease requires its nullable tuner host identity.');
  }
  if (typeof resource.close !== 'function') throw new TypeError('A live stream lease requires close().');
  if (resource.stream !== undefined && typeof resource.stream?.[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('A live stream body must be an asynchronous byte iterable.');
  }
  if (resource.sharing !== undefined && (!object(resource.sharing) || typeof resource.sharing.enabled !== 'boolean'
    || typeof resource.sharing.retain !== 'function')) {
    throw new TypeError('A shared live input requires enabled and retain({signal}).');
  }
  for (const member of executableMembers) if (member in resource) {
    throw unsupported('A live stream lease cannot expose recording or transcoding executors.');
  }
  return resource;
}
