import { nativeTextBytes } from '../database/native-text.js';
import { decodeNativeJsonArray, NativeItemJsonError, writeNativeDate } from './native-item-data.js';
import { MIN_DATE } from './records.js';
import { md5Guid, lowerInvariant } from '../core/identity.js';

export const liveTvStateKey = 'liveTvNativeState';
const statuses = ['New', 'InProgress', 'Completed', 'Cancelled', 'ConflictedOk', 'ConflictedNotOk', 'Error'];
const keepUntil = ['UntilDeleted', 'UntilSpaceNeeded', 'UntilWatched', 'UntilDate'];
const dateStates = new WeakMap();
const property = (name, kind, nullable = false, enumValues) => ({ name, kind, nullable, enumValues });
const properties = (names, kind, nullable = false) => names.split(' ').map(name => property(name, kind, nullable));
const common = [
  ...properties('Id ChannelId ProgramId Name Overview', 'string'),
  ...properties('StartDate EndDate', 'date'),
  ...properties('Priority PrePaddingSeconds PostPaddingSeconds', 'int'),
  ...properties('IsPrePaddingRequired IsPostPaddingRequired', 'bool'),
  property('KeepUntil', 'enum', false, keepUntil),
];
const contracts = {
  timers: [...common, ...properties('ProviderIds SeriesProviderIds', 'string-map', true),
    ...properties('Tags Genres', 'string[]'), ...properties('SeriesTimerId ShowId SeriesId EpisodeTitle HomePageUrl OfficialRating RecordingPath', 'string'),
    property('Status', 'enum', false, statuses), ...properties('IsManual IsMovie IsSeries IsProgramSeries IsRepeat', 'bool'),
    property('RetryCount', 'int'), ...properties('SeasonNumber EpisodeNumber ProductionYear', 'int', true),
    property('OriginalAirDate', 'date', true), property('CommunityRating', 'single', true)],
  seriesTimers: [...common, ...properties('ServiceName SeriesId', 'string'),
    ...properties('RecordAnyTime RecordAnyChannel SkipEpisodesInLibrary RecordNewOnly', 'bool'),
    property('KeepUpTo', 'int'), property('Days', 'DayOfWeek[]')],
};

function defaults(kind) {
  const result = Object.fromEntries(contracts[kind].map(({ name, kind, nullable }) => [name,
    nullable || kind === 'string' ? null : kind === 'date' ? MIN_DATE : kind === 'bool' ? false
      : kind.endsWith('[]') ? [] : kind === 'string-map' ? {} : kind === 'enum' ? name === 'Status' ? 'New' : 'UntilDeleted' : 0]));
  if (kind === 'seriesTimers') result.SkipEpisodesInLibrary = true;
  else { result.ProviderIds = {}; result.SeriesProviderIds = {}; }
  result.Status ??= 'New';
  result.SeriesTimerId ??= null;
  return result;
}

/** Import only. The raw file remains untouched for native state exchange. */
export function decodeLiveTvDocument(kind, text) {
  if (!Object.hasOwn(contracts, kind)) throw new TypeError('Unknown Live TV state document.');
  try {
    const entries = decodeNativeJsonArray(text, contracts[kind], () => defaults(kind), {
      onDateState: (entry, field, state) => {
        if (!dateStates.has(entry)) dateStates.set(entry, {});
        dateStates.get(entry)[field] = state;
      },
    });
    return { entries: entries ?? [], issue: entries === null ? 'null-document' : null };
  } catch (error) {
    if (!(error instanceof NativeItemJsonError)) throw error;
    return { entries: [], issue: 'invalid-json' };
  }
}

const bytes = value => value == null ? null : Buffer.from(nativeTextBytes(value)).toString('hex');
const internalId = value => md5Guid(lowerInvariant('Emby' + (value ?? '') + '4'));
const itemId = (value, type) => md5Guid(`MediaBrowser.Controller.LiveTv.${type}` + lowerInvariant('Emby' + (value ?? '') + '4'));
const dtoFields = common.map(field => field.name).filter(name => !['Id', 'ChannelId', 'ProgramId'].includes(name));
export function indexLiveTvDocument(kind, text) {
  const decoded = decodeLiveTvDocument(kind, text);
  return { issue: decoded.issue, rows: decoded.entries.map(entry => entry == null ? null : {
    internalId: internalId(entry.Id), channelInternalId: itemId(entry.ChannelId, 'LiveTvChannel'),
    programInternalId: itemId(entry.ProgramId, 'LiveTvProgram'), seriesTimerInternalId: internalId(entry.SeriesTimerId),
    id: bytes(entry.Id), name: bytes(entry.Name), programId: bytes(entry.ProgramId), seriesId: bytes(entry.SeriesId),
    channelId: bytes(entry.ChannelId), overview: bytes(entry.Overview),
    seriesTimerId: bytes(entry.SeriesTimerId), startDate: entry.StartDate, endDate: entry.EndDate, status: String(entry.Status),
    dto: Object.fromEntries([...dtoFields, ...(kind === 'timers' ? ['Status']
      : ['RecordAnyTime', 'SkipEpisodesInLibrary', 'RecordAnyChannel', 'KeepUpTo', 'RecordNewOnly', 'Days'])]
      .filter(name => !['Name', 'Overview'].includes(name)).map(name => [name,
        name === 'StartDate' || name === 'EndDate' ? writeNativeDate(entry[name], dateStates.get(entry)?.[name]) : entry[name]])),
  }) };
}
