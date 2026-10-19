import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { BindingError } from './binding.js';
import { emptyGuid } from '../syncplay/queue.js';

const guid = { type: 'guid', clrType: 'System.Guid', nullAsDefault: emptyGuid, preserveEmptyGuid: true };
const long = { type: 'long', clrType: 'System.Int64' };
const integer = { type: 'integer', clrType: 'System.Int32' };
const boolean = { type: 'boolean', clrType: 'System.Boolean' };
const ids = { type: 'array', clrType: 'System.Collections.Generic.IReadOnlyList`1[System.Guid]', nullable: true, item: guid };
const enumeration = (type, values) => ({ type: 'enum', clrType: `MediaBrowser.Model.SyncPlay.${type}`, values: Object.fromEntries(values.map((name, index) => [name, index])) });
const definitions = {
  NewGroupRequestDto: { defaults: { GroupName: '' }, fields: { GroupName: { type: 'string', clrType: 'System.String', nullable: true } }, required: ['GroupName'] },
  JoinGroupRequestDto: { defaults: { GroupId: emptyGuid }, fields: { GroupId: guid } },
  PlayRequestDto: { defaults: { PlayingQueue: [], PlayingItemPosition: 0, StartPositionTicks: 0n }, fields: { PlayingQueue: ids, PlayingItemPosition: integer, StartPositionTicks: long }, required: ['PlayingQueue'] },
  SetPlaylistItemRequestDto: { defaults: { PlaylistItemId: emptyGuid }, fields: { PlaylistItemId: guid } },
  RemoveFromPlaylistRequestDto: { defaults: { PlaylistItemIds: [], ClearPlaylist: false, ClearPlayingItem: false }, fields: { PlaylistItemIds: ids, ClearPlaylist: boolean, ClearPlayingItem: boolean }, required: ['PlaylistItemIds'] },
  MovePlaylistItemRequestDto: { defaults: { PlaylistItemId: emptyGuid, NewIndex: 0 }, fields: { PlaylistItemId: guid, NewIndex: integer } },
  QueueRequestDto: { defaults: { ItemIds: [], Mode: 'Queue' }, fields: { ItemIds: ids, Mode: enumeration('GroupQueueMode', ['Queue', 'QueueNext']) }, required: ['ItemIds'] },
  SeekRequestDto: { defaults: { PositionTicks: 0n }, fields: { PositionTicks: long } },
  BufferRequestDto: { defaults: { When: { ticks: 0n, kind: 'Unspecified' }, PositionTicks: 0n, IsPlaying: false, PlaylistItemId: emptyGuid }, fields: { When: { type: 'datetime', clrType: 'System.DateTime' }, PositionTicks: long, IsPlaying: boolean, PlaylistItemId: guid } },
  IgnoreWaitRequestDto: { defaults: { IgnoreWait: false }, fields: { IgnoreWait: boolean } },
  SetRepeatModeRequestDto: { defaults: { Mode: 'RepeatOne' }, fields: { Mode: enumeration('GroupRepeatMode', ['RepeatOne', 'RepeatAll', 'RepeatNone']) } },
  SetShuffleModeRequestDto: { defaults: { Mode: 'Sorted' }, fields: { Mode: enumeration('GroupShuffleMode', ['Sorted', 'Shuffle']) } },
  PingRequestDto: { defaults: { Ping: 0n }, fields: { Ping: long } }
};
definitions.ReadyRequestDto = definitions.BufferRequestDto;
definitions.NextItemRequestDto = definitions.PreviousItemRequestDto = definitions.SetPlaylistItemRequestDto;
const schema = { definitions };
const rootFor = type => ({ type: 'object', clrType: `Jellyfin.Api.Models.SyncPlayDtos.${type}`, reference: type, nullable: true });

export function bindSyncPlayDto(type, body, source) {
  return bindJsonModel(body, { schema, root: rootFor(type), source });
}

export function bindSyncPlayBody(type, body, source) {
  const root = rootFor(type);
  let value;
  try {
    value = bindSyncPlayDto(type, body, source);
    if (value == null) throw new BindingError('', 'A non-empty request body is required.');
  } catch (error) {
    if (error instanceof BindingError) error.errors.requestData = ['The requestData field is required.'];
    throw error;
  }
  try {
    validateJsonModel(value, { schema, root });
    if (type === 'NewGroupRequestDto' && value.GroupName.length > 200) throw new BindingError('GroupName', 'Group name must not exceed 200 characters.');
  } catch (error) { if (error instanceof BindingError) error.modelValidated = true; throw error; }
  return value;
}
