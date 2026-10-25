import playbackSchema from './resources/playback-body-schema.json' with { type: 'json' };
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { BindingError, queryValue, booleanValue, integerValue, guidValue } from './binding.js';
import { clrTrim } from '../metadata/whitespace.js';

const reference = 'Jellyfin.Api.Models.MediaInfoDtos.OpenLiveStreamDto';
const playbackFields = playbackSchema.definitions[playbackSchema.playback.reference].fields;
const names = ['OpenToken', 'UserId', 'PlaySessionId', 'MaxStreamingBitrate', 'StartTimeTicks', 'AudioStreamIndex',
  'SubtitleStreamIndex', 'MaxAudioChannels', 'ItemId', 'EnableDirectPlay', 'EnableDirectStream', 'AlwaysBurnInSubtitleWhenTranscoding'];
const fields = { ...Object.fromEntries(names.map(name => [name, playbackFields[name] ?? {
  type: name === 'ItemId' ? 'guid' : 'string', nullable: true, clrType: name === 'ItemId' ? 'System.Guid' : 'System.String' }])),
  DeviceProfile: playbackFields.DeviceProfile,
  DirectPlayProtocols: { type: 'array', nullable: true, clrType: 'System.Collections.Generic.IReadOnlyList`1[MediaBrowser.Model.MediaInfo.MediaProtocol]',
    item: { type: 'enum', nullable: false, clrType: 'MediaBrowser.Model.MediaInfo.MediaProtocol',
      values: { File: 0, Http: 1, Rtmp: 2, Rtsp: 3, Udp: 4, Rtp: 5, Ftp: 6 } } } };
const root = { type: 'object', nullable: true, clrType: reference, reference };
const schema = { definitions: { ...playbackSchema.definitions, [reference]: { fields, defaults: { DirectPlayProtocols: [] }, required: ['DirectPlayProtocols'] } } };

export function bindOpenLiveStreamBody(body, source) {
  return validateJsonModel(bindJsonModel(body, { schema, root, source }), { schema, root });
}

export function bindOpenLiveStreamQuery(query) {
  const result = {}, errors = {};
  for (const name of names) {
    const parameter = name[0].toLowerCase() + name.slice(1), value = queryValue(query, name);
    if (value == null) continue;
    try {
      const type = fields[name].type;
      if (type === 'string') result[name] = clrTrim(value) ? value : null;
      else if (type === 'guid') result[name] = guidValue(clrTrim(value), parameter);
      else if (type === 'integer') result[name] = integerValue(value, parameter);
      else if (type === 'boolean') result[name] = booleanValue(value, parameter);
      else if (type === 'long' && clrTrim(value)) {
        if (!/^[+-]?\d+$/u.test(clrTrim(value))) throw new BindingError(parameter, `The value '${value}' is not valid.`);
        const number = BigInt(value);
        if (number < -9223372036854775808n || number > 9223372036854775807n) throw new BindingError(parameter, `The value '${value}' is not valid.`);
        result[name] = number;
      }
    } catch (error) { if (!(error instanceof BindingError)) throw error; Object.assign(errors, error.errors); }
  }
  if (Object.keys(errors).length) { const error = new BindingError('', 'One or more validation errors occurred.'); error.errors = errors; throw error; }
  return result;
}

export function openLiveStreamOptions({ body, queryInput }) {
  const result = { ...(body ?? {}), DirectPlayProtocols: body?.DirectPlayProtocols ?? ['Http'] };
  for (const [name, value] of Object.entries(queryInput ?? {})) if (value != null) result[name] = value;
  result.EnableDirectPlay ??= true; result.EnableDirectStream ??= true; result.AlwaysBurnInSubtitleWhenTranscoding ??= false;
  return result;
}

export function bindCloseLiveStreamQuery(query) {
  const value = queryValue(query, 'liveStreamId');
  if (value == null || !clrTrim(value)) throw new BindingError('liveStreamId', 'The liveStreamId field is required.');
  return value;
}

export function bindLiveStreamFileContainer(value) {
  if (!value || !/^[a-zA-Z0-9\-._,|]{0,40}$/u.test(value)) throw new BindingError('container',
    !value ? 'The container field is required.' : 'The field container must match the regular expression \'^[a-zA-Z0-9\\-\\._,|]{0,40}$\'.');
  return value;
}
