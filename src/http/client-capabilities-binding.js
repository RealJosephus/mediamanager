import playbackSchema from './resources/playback-body-schema.json' with { type: 'json' };
import { bindJsonModel } from './json-model-binding.js';
import { BindingError } from './binding.js';

const mediaTypes = ['Unknown', 'Video', 'Audio', 'Photo', 'Book'];
const generalCommands = ['MoveUp', 'MoveDown', 'MoveLeft', 'MoveRight', 'PageUp', 'PageDown', 'PreviousLetter', 'NextLetter', 'ToggleOsd', 'ToggleContextMenu', 'Select', 'Back', 'TakeScreenshot', 'SendKey', 'SendString', 'GoHome', 'GoToSettings', 'VolumeUp', 'VolumeDown', 'Mute', 'Unmute', 'ToggleMute', 'SetVolume', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'ToggleFullscreen', 'DisplayContent', 'GoToSearch', 'DisplayMessage', 'SetRepeatMode', 'ChannelUp', 'ChannelDown', 'Guide', 'ToggleStats', 'PlayMediaSource', 'PlayTrailers', 'SetShuffleQueue', 'PlayState', 'PlayNext', 'ToggleOsdMenu', 'Play', 'SetMaxStreamingBitrate', 'SetPlaybackOrder'];
const enumRule = (clrType, values) => ({ type: 'enum', nullable: false, clrType,
  values: Object.fromEntries(values.map((name, index) => [name, index])) });
const listRule = (clrType, item) => ({ type: 'array', nullable: true, clrType, item,
  delimiter: ',', converterArrayRoot: true });
const reference = 'MediaBrowser.Model.Dto.ClientCapabilitiesDto';
const root = { type: 'object', nullable: true, clrType: reference, reference };
const schema = {
  definitions: {
    ...playbackSchema.definitions,
    [reference]: {
      fields: {
        PlayableMediaTypes: listRule('System.Collections.Generic.IReadOnlyList`1[Jellyfin.Data.Enums.MediaType]', enumRule('Jellyfin.Data.Enums.MediaType', mediaTypes)),
        SupportedCommands: listRule('System.Collections.Generic.IReadOnlyList`1[MediaBrowser.Model.Session.GeneralCommandType]', enumRule('MediaBrowser.Model.Session.GeneralCommandType', generalCommands)),
        SupportsMediaControl: { type: 'boolean', nullable: false, clrType: 'System.Boolean' },
        SupportsPersistentIdentifier: { type: 'boolean', nullable: false, clrType: 'System.Boolean' },
        DeviceProfile: playbackSchema.definitions[playbackSchema.playback.reference].fields.DeviceProfile,
        AppStoreUrl: { type: 'string', nullable: true, clrType: 'System.String' },
        IconUrl: { type: 'string', nullable: true, clrType: 'System.String' }
      },
      defaults: {
        PlayableMediaTypes: [], SupportedCommands: [], SupportsMediaControl: false,
        SupportsPersistentIdentifier: false, DeviceProfile: null, AppStoreUrl: null, IconUrl: null
      },
      required: []
    }
  }
};

export function bindClientCapabilitiesDto(body, source) {
  return bindJsonModel(body, { schema, root, source });
}

export function validateClientCapabilitiesDto(body, source) {
  try {
    const result = bindClientCapabilitiesDto(body, source);
    if (result != null) return result;
    const error = new BindingError('capabilities', 'The capabilities field is required.');
    throw error;
  } catch (error) {
    if (!(error instanceof BindingError) || error.errors.capabilities) throw error;
    error.errors = { capabilities: ['The capabilities field is required.'], ...error.errors };
    throw error;
  }
}
