import { BindingError } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';
import itemUpdateSchema from './resources/item-update-schema.json' with { type: 'json' };

const scalar = (type, clrType, nullable = false) => ({ type, clrType, nullable });
const string = scalar('string', 'System.String', true);
const integer = scalar('integer', 'System.Int32');
const boolean = scalar('boolean', 'System.Boolean');
const date = scalar('datetime', 'System.DateTime');
const guid = { ...scalar('guid', 'System.Guid'), preserveEmptyGuid: true };
const enumeration = (clrType, names, nullable = false) => ({ type: 'enum', clrType, nullable,
  values: Object.fromEntries(names.map((name, index) => [name, index])) });
const array = (clrType, item, nullable = true) => ({ type: 'array', clrType, nullable, item });
const dictionary = (clrType, key, item, nullable = true) => ({ type: 'dictionary', clrType, nullable, key, item });
const emptyGuid = '00000000000000000000000000000000';
const minimumDate = '0001-01-01T00:00:00.0000000Z';
const keepUntil = enumeration('MediaBrowser.Model.LiveTv.KeepUntil',
  ['UntilDeleted', 'UntilSpaceNeeded', 'UntilWatched', 'UntilDate']);
const recordingStatus = enumeration('MediaBrowser.Model.LiveTv.RecordingStatus',
  ['New', 'InProgress', 'Completed', 'Cancelled', 'ConflictedOk', 'ConflictedNotOk', 'Error']);
const day = enumeration('System.DayOfWeek', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const dayPattern = enumeration('MediaBrowser.Model.LiveTv.DayPattern', ['Daily', 'Weekdays', 'Weekends'], true);
const imageType = enumeration('MediaBrowser.Model.Entities.ImageType',
  ['Primary', 'Art', 'Backdrop', 'Banner', 'Logo', 'Thumb', 'Disc', 'Box', 'Screenshot', 'Menu', 'Chapter', 'BoxRear', 'Profile']);

const baseDefaults = { Id: null, Type: null, ServerId: null, ExternalId: null, ChannelId: emptyGuid,
  ExternalChannelId: null, ChannelName: null, ChannelPrimaryImageTag: null, ProgramId: null, ExternalProgramId: null,
  Name: null, Overview: null, StartDate: minimumDate, EndDate: minimumDate, ServiceName: null, Priority: 0,
  PrePaddingSeconds: 0, PostPaddingSeconds: 0, IsPrePaddingRequired: false, ParentBackdropItemId: null,
  ParentBackdropImageTags: null, IsPostPaddingRequired: false, KeepUntil: 'UntilDeleted' };
const baseFields = { Id: string, Type: string, ServerId: string, ExternalId: string, ChannelId: guid,
  ExternalChannelId: string, ChannelName: string, ChannelPrimaryImageTag: string, ProgramId: string,
  ExternalProgramId: string, Name: string, Overview: string, StartDate: date, EndDate: date, ServiceName: string,
  Priority: integer, PrePaddingSeconds: integer, PostPaddingSeconds: integer, IsPrePaddingRequired: boolean,
  ParentBackdropItemId: string, ParentBackdropImageTags: array('System.String[]', string),
  IsPostPaddingRequired: boolean, KeepUntil: keepUntil };
const definitions = {
  ...itemUpdateSchema.definitions,
  TimerInfoDto: { defaults: { ...baseDefaults, Type: 'Timer', Status: 'New', SeriesTimerId: null,
    ExternalSeriesTimerId: null, RunTimeTicks: null, ProgramInfo: null }, fields: { ...baseFields,
    Status: recordingStatus, SeriesTimerId: string, ExternalSeriesTimerId: string,
    RunTimeTicks: scalar('long', 'System.Int64', true),
    ProgramInfo: { type: 'object', reference: 'MediaBrowser.Model.Dto.BaseItemDto',
      clrType: 'MediaBrowser.Model.Dto.BaseItemDto', nullable: true } } },
  SeriesTimerInfoDto: { defaults: { ...baseDefaults, Type: 'SeriesTimer', RecordAnyTime: false,
    SkipEpisodesInLibrary: false, RecordAnyChannel: false, KeepUpTo: 0, RecordNewOnly: false, Days: [], DayPattern: null,
    ImageTags: new Map(), ParentThumbItemId: null, ParentThumbImageTag: null, ParentPrimaryImageItemId: null,
    ParentPrimaryImageTag: null }, fields: { ...baseFields, RecordAnyTime: boolean, SkipEpisodesInLibrary: boolean,
    RecordAnyChannel: boolean, KeepUpTo: integer, RecordNewOnly: boolean,
    Days: array('System.DayOfWeek[]', day), DayPattern: dayPattern,
    ImageTags: dictionary('System.Collections.Generic.Dictionary`2[MediaBrowser.Model.Entities.ImageType,System.String]', imageType, string),
    ParentThumbItemId: string, ParentThumbImageTag: string,
    ParentPrimaryImageItemId: { ...guid, nullable: true }, ParentPrimaryImageTag: string } },
};
const schema = { definitions };

export function bindLiveTvTimerBody(kind, body, source) {
  const name = kind === 'timer' ? 'TimerInfoDto' : kind === 'seriesTimer' ? 'SeriesTimerInfoDto' : null;
  if (!name) throw new TypeError('Unknown Live TV timer DTO kind.');
  if (body === null) throw new BindingError('', 'A non-empty request body is required.');
  const root = { type: 'object', reference: name, nullable: true, clrType: `MediaBrowser.Model.LiveTv.${name}` };
  return bindJsonModel(body, { schema, root, source });
}
