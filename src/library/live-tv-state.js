import { nativeTextBytes } from '../database/native-text.js';
import { decodeNativeJsonArray, NativeItemJsonError } from './native-item-data.js';
import { MIN_DATE } from './records.js';
import { md5Guid, lowerInvariant } from '../core/identity.js';

export const liveTvStateKey = 'liveTvNativeState';
const statuses = ['New', 'InProgress', 'Completed', 'Cancelled', 'ConflictedOk', 'ConflictedNotOk', 'Error'];
const keepUntil = ['UntilDeleted', 'UntilSpaceNeeded', 'UntilWatched', 'UntilDate'];
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

/** Import only. The raw file remains untouched for native state exchange. */
export function decodeLiveTvDocument(kind, text) {
  if (!Object.hasOwn(contracts, kind)) throw new TypeError('Unknown Live TV state document.');
  try {
    const entries = decodeNativeJsonArray(text, contracts[kind], () => ({ Id: null, Name: null,
      ProgramId: null, SeriesId: null, SeriesTimerId: null, StartDate: MIN_DATE, Status: 'New' }));
    return { entries: entries ?? [], issue: entries === null ? 'null-document' : null };
  } catch (error) {
    if (!(error instanceof NativeItemJsonError)) throw error;
    return { entries: [], issue: 'invalid-json' };
  }
}

const bytes = value => value == null ? null : Buffer.from(nativeTextBytes(value)).toString('hex');
export function indexLiveTvDocument(kind, text) {
  const decoded = decodeLiveTvDocument(kind, text);
  return { issue: decoded.issue, rows: decoded.entries.map(entry => entry == null ? null : {
    internalId: md5Guid(lowerInvariant('Emby' + (entry.Id ?? '') + '4')),
    id: bytes(entry.Id), name: bytes(entry.Name), programId: bytes(entry.ProgramId), seriesId: bytes(entry.SeriesId),
    seriesTimerId: bytes(entry.SeriesTimerId), startDate: entry.StartDate, status: String(entry.Status),
  }) };
}
