import { tokenizeJson } from '@mediamanager/plugin-sdk/core/json-tokens';
import { quoteNativeJsonString } from '@mediamanager/plugin-sdk/core/json';

const failure = () => new SyntaxError('The HDHomeRun JSON value cannot be converted to its declared native type.');
const channelFields = ['Name', 'Number', 'Id', 'Path', 'TunerChannelId', 'CallSign', 'TunerHostId', 'ChannelType', 'ChannelGroup', 'ImagePath', 'ImageUrl', 'HasImage', 'IsFavorite', 'IsHD', 'AudioCodec', 'VideoCodec', 'Tags'];
const modelStrings = ['FriendlyName', 'ModelNumber', 'FirmwareName', 'FirmwareVersion', 'DeviceID', 'DeviceAuth', 'BaseURL', 'LineupURL'];
const lineupStrings = ['GuideNumber', 'GuideName', 'VideoCodec', 'AudioCodec', 'URL'];
const scalar = node => !node.properties && !node.items;
function string(node, source, relaxed) {
  if (!scalar(node)) throw failure();
  if (node.value == null) return null;
  if (typeof node.value === 'string') { if (!node.value.isWellFormed()) throw failure(); return node.value; }
  if (relaxed) return source.slice(node.start, node.end);
  throw failure();
}
function integer(node, source, relaxed) {
  if (!scalar(node) || typeof node.value === 'boolean' || node.value === null) throw failure();
  if (typeof node.value === 'string' && !relaxed) throw failure();
  const value = typeof node.value === 'string' ? node.value : source.slice(node.start, node.end);
  if (!/^[+-]?\d+$/u.test(value)) throw failure();
  const result = BigInt(value); if (result < -2147483648n || result > 2147483647n) throw failure(); return Number(result);
}
function boolean(node, source, { numeric = false, nullable = false } = {}) {
  if (scalar(node) && typeof node.value === 'boolean') return node.value;
  if (scalar(node) && nullable && node.value === null) return null;
  if (numeric && typeof node.value !== 'string') return integer(node, source, false) !== 0;
  throw failure();
}
function object(node, schema, defaults, source) {
  if (scalar(node) && node.value === null) return null;
  if (!node.properties) throw failure();
  const result = structuredClone(defaults);
  for (const [key, value] of node.properties) if (Object.hasOwn(schema, key)) result[key] = schema[key](value);
  return result;
}
function parse(source, operation) {
  source = source.replace(/^\uFEFF/u, '');
  JSON.parse(source); return operation(tokenizeJson(source), source);
}
export function parseModel(source) {
  return parse(source, (node, text) => object(node, { ...Object.fromEntries(modelStrings.map(key => [key, value => string(value, text, true)])),
    TunerCount: value => integer(value, text, true) }, { ...Object.fromEntries(modelStrings.map(key => [key, null])), TunerCount: 0 }, text));
}
export function parseLineup(source) {
  return parse(source, (node, text) => {
    if (scalar(node) && node.value === null) return [];
    if (!node.items) throw failure();
    return node.items.map(value => object(value, { ...Object.fromEntries(lineupStrings.map(key => [key, value => string(value, text, true)])),
      ...Object.fromEntries(['Favorite', 'DRM', 'HD'].map(key => [key, value => boolean(value, text, { numeric: true })])) },
    { ...Object.fromEntries(lineupStrings.map(key => [key, null])), Favorite: false, DRM: false, HD: false }, text));
  });
}
export function parseChannelCache(source) {
  return parse(source, (node, text) => {
    if (scalar(node) && node.value === null) throw new TypeError('Value cannot be null. (Parameter collection)');
    if (!node.items) throw failure();
    const strings = channelFields.filter(key => !['ChannelType', 'Tags', 'HasImage', 'IsFavorite', 'IsHD'].includes(key));
    const schema = { ...Object.fromEntries(strings.map(key => [key, value => string(value, text, false)])),
      ...Object.fromEntries(['HasImage', 'IsFavorite', 'IsHD'].map(key => [key, value => boolean(value, text, { nullable: true })])),
      ChannelType: value => ({ 0: 'TV', 1: 'Radio' })[integer(value, text, false)] ?? integer(value, text, false),
      Tags: value => {
        if (scalar(value) && value.value === null) return null;
        if (!value.items) throw failure(); return value.items.map(value => string(value, text, false));
      } };
    return node.items.map(value => object(value, schema, Object.fromEntries(channelFields.map(key => [key, key === 'ChannelType' ? 'TV' : null])), text));
  });
}
export function serializeChannelCache(channels) {
  const scalar = value => value == null ? 'null' : typeof value === 'string' ? quoteNativeJsonString(value) : JSON.stringify(value);
  return '[' + channels.map(channel => channel === null ? 'null' : '{' + channelFields.map(key => quoteNativeJsonString(key) + ':'
    + (key === 'ChannelType' ? String(({ TV: 0, Radio: 1 })[channel[key]] ?? channel[key] ?? 0)
      : key === 'Tags' && Array.isArray(channel[key]) ? '[' + channel[key].map(scalar).join(',') + ']' : scalar(channel[key]))).join(',') + '}').join(',') + ']';
}
