import { md5Guid } from '../core/identity.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { guideProgramId } from './live-tv-guide-program.js';
import { dateTicks } from './records.js';

const metadataFields = ['ChannelId', 'CommunityRating', 'EndDate', 'EpisodeNumber', 'EpisodeTitle', 'Genres',
  'IsMovie', 'IsSeries', 'Tags', 'IsProgramSeries', 'IsRepeat', 'Name', 'OfficialRating', 'OriginalAirDate',
  'Overview', 'ProductionYear', 'ProgramId', 'SeasonNumber', 'StartDate', 'ShowId', 'ProviderIds', 'SeriesProviderIds'];
export const recordingPadding = ['PrePaddingSeconds', 'PostPaddingSeconds', 'IsPrePaddingRequired', 'IsPostPaddingRequired'];
const timerSettings = ['KeepUntil', 'Priority', ...recordingPadding];
export const seriesTimerSettings = ['ChannelId', 'Days', 'StartDate', 'EndDate', 'RecordAnyChannel', 'RecordAnyTime',
  'RecordNewOnly', 'SkipEpisodesInLibrary', 'KeepUpTo', ...timerSettings];
export const selectTimerFields = (record, fields) => Object.fromEntries(fields.map(field => [field, record[field]]));
const day = 864000000000n;
const closeTime = (a, b) => {
  const difference = dateTicks(a) % day - dateTicks(b) % day;
  return difference > -6000000000n && difference < 6000000000n;
};

const programKey = value => value?.trim() ? ordinalIgnoreCaseKey(value) : undefined;

function addProgramIndex(indices, index) {
  let position = indices.length;
  while (position > 0) {
    const parent = Math.floor((position - 1) / 2);
    if (indices[parent] <= index) break;
    indices[position] = indices[parent];
    position = parent;
  }
  indices[position] = index;
}

function removeFirstProgramIndex(indices) {
  const last = indices.pop();
  if (indices.length === 0) return;
  let position = 0;
  while (position * 2 + 1 < indices.length) {
    const left = position * 2 + 1, right = left + 1;
    const child = right < indices.length && indices[right] < indices[left] ? right : left;
    if (last <= indices[child]) break;
    indices[position] = indices[child];
    position = child;
  }
  indices[position] = last;
}

/** Materialize guide occurrences while retaining manual timer identities and fields. */
export async function planSeriesEpisodes(series, entries, visitCandidates, { adopt = false, updateSettings = false, deleteInvalid = false, isActive, now }) {
  const changes = new Map(), append = [], events = [], selected = new Set(), enabled = new Map();
  const byId = new Map(), byProgram = new Map(), indexedPrograms = [];
  const indexProgram = (index, key) => {
    if (indexedPrograms[index] === key) return;
    indexedPrograms[index] = key;
    if (!key) return;
    let indices = byProgram.get(key);
    if (!indices) byProgram.set(key, indices = []);
    addProgramIndex(indices, index);
  };
  const firstForProgram = key => {
    const indices = byProgram.get(key);
    // An exact timer-ID match can reassign an existing timer's program. Drop
    // stale entries lazily while preserving the first saved match for a program.
    while (indices?.length && indexedPrograms[indices[0]] !== key) removeFirstProgramIndex(indices);
    return indices?.[0] ?? -1;
  };
  const update = (index, fields) => {
    Object.assign(entries[index], fields);
    changes.set(index, { ...changes.get(index), ...fields });
  };
  for (const [index, timer] of entries.entries()) {
    if (!timer) continue;
    if (typeof timer.Id === 'string') {
      const key = ordinalIgnoreCaseKey(timer.Id);
      if (!byId.has(key)) byId.set(key, index);
    }
    indexProgram(index, programKey(timer.ProgramId));
    if (adopt && timer.Status !== 'Completed' && (
      series.ProgramId?.trim() && ordinalIgnoreCaseEquals(series.ProgramId, timer.ProgramId)
      || series.SeriesId?.trim() && ordinalIgnoreCaseEquals(series.SeriesId, timer.SeriesId))) {
      update(index, { SeriesTimerId: series.Id, IsManual: true });
    }
  }

  await visitCandidates(({ program, channelHd, inLibrary }) => {
    const Id = md5Guid(series.Id + (program.ProgramId ?? ''));
    const key = ordinalIgnoreCaseKey(Id), programId = programKey(program.ProgramId);
    const match = byId.get(key);
    if (match !== undefined) selected.add(key);
    const index = match ?? firstForProgram(programId);
    const existing = entries[index];
    if (existing && (isActive(Id) || isActive(existing.Id))) return;
    const cancel = !existing?.IsManual && (
      !series.RecordAnyTime && !closeTime(series.StartDate, program.StartDate)
      || series.RecordNewOnly && program.IsRepeat
      || !series.RecordAnyChannel && !ordinalIgnoreCaseEquals(series.ChannelId, program.ChannelId)
      || series.SkipEpisodesInLibrary && inLibrary
    );
    const Status = cancel ? 'Cancelled' : existing?.IsManual ? existing.Status : 'New';
    const common = { ...selectTimerFields(program, metadataFields), Status, SeriesTimerId: series.Id };
    let timer;
    if (existing) {
      update(index, { ...common, ...(updateSettings && selectTimerFields(series, timerSettings)) });
      indexProgram(index, programId);
      timer = existing;
    } else {
      timer = { Id, ...common, SeriesId: program.SeriesId, IsManual: false, RetryCount: 0, ...selectTimerFields(series, timerSettings) };
      append.push(timer);
      events.push({ type: 'TimerCreated', data: { Id, ProgramId: guideProgramId(program.ProgramId) } });
    }
    if (Status !== 'Cancelled' && series.SkipEpisodesInLibrary && timer.ShowId?.trim() && !timer.ShowId.endsWith('0000')) {
      const group = enabled.get(timer.ShowId) ?? [];
      group.push({ index, timer, channelHd }); enabled.set(timer.ShowId, group);
    }
  });

  for (const group of enabled.values()) {
    group.sort((a, b) => Number(b.channelHd) - Number(a.channelHd) || Date.parse(a.timer.StartDate) - Date.parse(b.timer.StartDate));
    for (const { index, timer } of group.slice(1)) {
      if (index < 0) timer.Status = 'Cancelled';
      else update(index, { Status: 'Cancelled' });
    }
  }
  if (deleteInvalid) for (const [index, timer] of entries.entries()) {
    if (timer?.Status !== 'New' || !ordinalIgnoreCaseEquals(timer.SeriesTimerId, series.Id)
      || selected.has(ordinalIgnoreCaseKey(timer.Id)) || Date.parse(timer.StartDate) <= now) continue;
    update(index, { Status: 'Cancelled', IsManual: false });
    events.push({ type: 'TimerCancelled', data: { Id: timer.Id } });
  }
  return { changes, append, events };
}
