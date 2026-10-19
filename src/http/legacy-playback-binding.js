import { BindingError, guidValue, queryValue } from './binding.js';
import { enumName } from '../sessions/binding.js';
import { int64 } from '../sessions/user-data.js';

const playMethods = ['Transcode', 'DirectStream', 'DirectPlay'];
const repeatModes = ['RepeatNone', 'RepeatAll', 'RepeatOne'];

export function bindLegacyPlaybackRequest(context, action) {
  const errors = {};
  const query = name => queryValue(context.query, name);
  const capture = (name, convert) => {
    try { return convert(); }
    catch (error) {
      if (!(error instanceof BindingError)) throw error;
      Object.assign(errors, error.errors);
      return null;
    }
  };
  const guid = name => capture(name, () => guidValue(context.params[name], name));
  const nullableInteger = name => {
    const raw = query(name);
    if (raw === undefined || !raw.trim()) return null;
    if (!/^[+-]?\d+$/u.test(raw.trim()) || Number(raw) < -2147483648 || Number(raw) > 2147483647) {
      errors[name] = [`The value '${raw}' is not valid.`];
      return null;
    }
    return Number(raw);
  };
  const nullableLong = name => {
    const raw = query(name);
    if (raw === undefined || !raw.trim()) return null;
    try { return int64(raw); }
    catch {
      errors[name] = [`The value '${raw}' is not valid.`];
      return null;
    }
  };
  const boolean = name => {
    const raw = query(name);
    if (raw === undefined) return false;
    if (/^true$/iu.test(raw.trim())) return true;
    if (/^false$/iu.test(raw.trim())) return false;
    errors[name] = [`The value '${raw}' is ${raw.trim() ? 'not valid' : 'invalid'}.`];
    return false;
  };
  const nullableEnum = (name, names) => {
    const raw = query(name);
    if (raw === undefined || !raw.trim()) return null;
    try { return enumName(raw, names); }
    catch { return null; }
  };

  const userId = context.params.userId ? guid('userId') : null;
  const itemId = guid('itemId');
  const common = {
    ItemId: itemId,
    MediaSourceId: query('mediaSourceId'),
    PositionTicks: action === 'start' ? null : nullableLong('positionTicks'),
    LiveStreamId: query('liveStreamId'),
    PlaySessionId: query('playSessionId')
  };
  let info;
  if (action === 'stop') info = { ...common, NextMediaType: query('nextMediaType') };
  else info = {
    ...common,
    AudioStreamIndex: nullableInteger('audioStreamIndex'),
    SubtitleStreamIndex: nullableInteger('subtitleStreamIndex'),
    PlayMethod: nullableEnum('playMethod', playMethods) ?? 'Transcode',
    ...(action === 'start' ? { CanSeek: boolean('canSeek') } : {
      VolumeLevel: nullableInteger('volumeLevel'),
      RepeatMode: nullableEnum('repeatMode', repeatModes) ?? 'RepeatNone',
      IsPaused: boolean('isPaused'),
      IsMuted: boolean('isMuted')
    })
  };
  if (Object.keys(errors).length) {
    const error = new BindingError('', 'One or more validation errors occurred.');
    error.errors = errors;
    throw error;
  }
  return { userId, info };
}
