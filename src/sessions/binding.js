import { domainError, equalsIgnoreCase, nativeGuid, normalizeMembers } from '../users/native.js';
import { emptyGuid, guidN, int64 } from './user-data.js';
import { bindDeviceProfile } from '../http/playback-binding.js';

const playMethods = ['Transcode', 'DirectStream', 'DirectPlay'];
const repeatModes = ['RepeatNone', 'RepeatAll', 'RepeatOne'];
const playbackOrders = ['Default', 'Shuffle'];
export const mediaTypes = ['Unknown', 'Video', 'Audio', 'Photo', 'Book'];
const commands = ['MoveUp', 'MoveDown', 'MoveLeft', 'MoveRight', 'PageUp', 'PageDown', 'PreviousLetter', 'NextLetter', 'ToggleOsd', 'ToggleContextMenu', 'Select', 'Back', 'TakeScreenshot', 'SendKey', 'SendString', 'GoHome', 'GoToSettings', 'VolumeUp', 'VolumeDown', 'Mute', 'Unmute', 'ToggleMute', 'SetVolume', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'ToggleFullscreen', 'DisplayContent', 'GoToSearch', 'DisplayMessage', 'SetRepeatMode', 'ChannelUp', 'ChannelDown', 'Guide', 'ToggleStats', 'PlayMediaSource', 'PlayTrailers', 'SetShuffleQueue', 'PlayState', 'PlayNext', 'ToggleOsdMenu', 'Play', 'SetMaxStreamingBitrate', 'SetPlaybackOrder'];
export const defaultCapabilities = () => ({ PlayableMediaTypes: [], SupportedCommands: [], SupportsMediaControl: false, SupportsPersistentIdentifier: true, DeviceProfile: null, AppStoreUrl: null, IconUrl: null });

export function enumName(value, names) {
  let numeric = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[+-]?\d+$/.test(text)) numeric = Number(text);
    else {
      numeric = 0;
      for (const part of text.split(',')) {
        const index = names.findIndex(name => equalsIgnoreCase(name, part.trim()));
        if (index < 0) throw domainError(400, 'Invalid enum value.');
        numeric |= index;
      }
    }
  }
  if (!Number.isInteger(numeric) || numeric < -2147483648 || numeric > 2147483647) throw domainError(400, 'Invalid enum value.');
  return names[numeric] ?? numeric;
}

export const playCommands = ['PlayNow', 'PlayNext', 'PlayLast', 'PlayInstantMix', 'PlayShuffle'];
export const playstateCommands = ['Stop', 'Pause', 'Unpause', 'NextTrack', 'PreviousTrack', 'Seek', 'Rewind', 'FastForward', 'PlayPause'];
export const generalCommands = commands;
export const itemKinds = ['AggregateFolder', 'Audio', 'AudioBook', 'BasePluginFolder', 'Book', 'BoxSet', 'Channel', 'ChannelFolderItem', 'CollectionFolder', 'Episode', 'Folder', 'Genre', 'ManualPlaylistsFolder', 'Movie', 'LiveTvChannel', 'LiveTvProgram', 'MusicAlbum', 'MusicArtist', 'MusicGenre', 'MusicVideo', 'Person', 'Photo', 'PhotoAlbum', 'Playlist', 'PlaylistsFolder', 'Program', 'Recording', 'Season', 'Series', 'Studio', 'Trailer', 'TvChannel', 'TvProgram', 'UserRootFolder', 'UserView', 'Video', 'Year'];

function boolean(value) {
  if (typeof value !== 'boolean') throw domainError(400, 'Invalid Boolean.');
  return value;
}
function integer(value) {
  const result = int64(value);
  if (result < -2147483648n || result > 2147483647n) throw domainError(400, 'Int32 out of range.');
  return Number(result);
}

export function bindCapabilities(value) {
  const result = normalizeMembers(value, defaultCapabilities());
  for (const key of ['SupportsMediaControl', 'SupportsPersistentIdentifier']) result[key] = boolean(result[key]);
  for (const [key, names] of [['PlayableMediaTypes', mediaTypes], ['SupportedCommands', commands]]) {
    if (result[key] == null) continue;
    if (!Array.isArray(result[key])) throw domainError(400, 'An array is required.');
    result[key] = result[key].map(entry => enumName(entry, names));
  }
  if (result.DeviceProfile != null) result.DeviceProfile = bindDeviceProfile(result.DeviceProfile);
  return result;
}

export function bindPlaybackReport(value, { stopped = false } = {}) {
  const common = { Item: null, ItemId: emptyGuid, SessionId: null, MediaSourceId: null, PositionTicks: null, LiveStreamId: null, PlaySessionId: null, NowPlayingQueue: null, PlaylistItemId: null };
  const result = normalizeMembers(value, stopped ? { ...common, Failed: false, NextMediaType: null } : { ...common, CanSeek: false, AudioStreamIndex: null, SubtitleStreamIndex: null, IsPaused: false, IsMuted: false, PlaybackStartTimeTicks: null, VolumeLevel: null, Brightness: null, AspectRatio: null, PlayMethod: 'Transcode', RepeatMode: 'RepeatNone', PlaybackOrder: 'Default' });
  result.ItemId = guidN(nativeGuid(result.ItemId));
  for (const key of stopped ? ['Failed'] : ['CanSeek', 'IsPaused', 'IsMuted']) result[key] = boolean(result[key]);
  for (const key of ['PositionTicks', 'PlaybackStartTimeTicks']) if (result[key] != null) result[key] = int64(result[key]);
  for (const key of ['AudioStreamIndex', 'SubtitleStreamIndex', 'VolumeLevel', 'Brightness']) if (result[key] != null) result[key] = integer(result[key]);
  if (!stopped) for (const [key, names] of [['PlayMethod', playMethods], ['RepeatMode', repeatModes], ['PlaybackOrder', playbackOrders]]) result[key] = enumName(result[key], names);
  if (result.NowPlayingQueue != null) {
    if (!Array.isArray(result.NowPlayingQueue)) throw domainError(400, 'An array is required.');
    result.NowPlayingQueue = result.NowPlayingQueue.map(entry => {
      if (entry == null) return null;
      const item = normalizeMembers(entry, { Id: emptyGuid, PlaylistItemId: null });
      item.Id = guidN(nativeGuid(item.Id));
      return item;
    });
  }
  return result;
}
