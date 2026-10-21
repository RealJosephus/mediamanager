import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { readNativeImageRows } from '../database/native-relation-order.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { cloneNativeValue } from '../core/json.js';
import { md5Guid, lowerInvariant } from '../core/identity.js';
import { nativeGuid } from '../users/native.js';
import { loadPostgresRowsByIds } from './postgres-library-query.js';
import { queryPostgresLiveTvTimerPage } from './postgres-live-tv-timers-query.js';
import { imageTagAndBlurHash } from './dto-inherited-images.js';
import { EMPTY_ID, MIN_DATE, dateText, dateTicks, dtoId, idKey, libraryError, mapRecord } from './records.js';

const text = value => value == null ? null : decodeNativeTextBytes(Buffer.from(value, 'hex'));
const present = value => value != null && value !== '';
const timerId = value => md5Guid(lowerInvariant('Emby' + (value ?? '') + '4'));
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function liveTvDayPattern(values) {
  if (values.length === 7) return 'Daily';
  if (values.length === 2 && values.includes('Saturday') && values.includes('Sunday')) return 'Weekends';
  if (values.length === 5 && days.slice(1, 6).every(day => values.includes(day))) return 'Weekdays';
  return null;
}

/** Read saved timers without starting timer, stream or recording executors. */
export class LiveTvTimersService {
  constructor({ store, serverId, loadProgramDtos, liveTv, loadProgram, onError = () => {} } = {}) {
    if (!store || typeof loadProgramDtos !== 'function') throw new TypeError('Timer reads require PostgreSQL and program DTO projection.');
    Object.assign(this, { store, serverId, loadProgramDtos, liveTv, loadProgram, onError });
  }

  #report(error) { try { void Promise.resolve(this.onError(error)).catch(() => {}); } catch { /* Image errors are diagnostic. */ } }

  #guid(value) {
    if (!present(value)) return undefined;
    try { return idKey(nativeGuid(value)); }
    catch { throw libraryError(500, 'Invalid Live TV timer query identifier.'); }
  }

  getTimers(query = {}) {
    return this.#read('timers', { ...query, channelId: this.#guid(query.channelId), seriesTimerId: this.#guid(query.seriesTimerId) });
  }
  async getTimer(id) { return this.#read('timers', {}, { id, scalar: true }); }
  getSeriesTimers(query = {}) { return this.#read('seriesTimers', query); }
  getSeriesTimer(id) { return this.#read('seriesTimers', {}, { id, scalar: true }); }

  #read(kind, query, { id, scalar = false } = {}) {
    return this.store.run(async database => {
      const result = [];
      let selected = null, total = 0;
      for (let offset = 0; ; offset += 128) {
        const page = await queryPostgresLiveTvTimerPage(database, kind, query, { offset, id });
        total = page.total;
        const projected = await this.#projectPage(database, kind, page.rows.map(row => row.value));
        for (let index = 0; index < projected.length; index++) {
          if (scalar) { if (page.rows[index].requested && selected === null) selected = projected[index]; }
          else result.push(projected[index]);
        }
        if (offset + page.rows.length >= total || !page.rows.length) break;
      }
      return scalar ? selected : { Items: result, TotalRecordCount: total, StartIndex: 0 };
    });
  }

  async #projectPage(database, kind, rows) {
    if (!rows.length) return [];
    const series = kind === 'seriesTimers';
    const channelIds = [...new Set(rows.filter(row => present(text(row.channelId))).map(row => row.channelInternalId))];
    const channels = new Map((await loadPostgresRowsByIds(database, channelIds)).map(row => [idKey(row.Id), mapRecord(row)]));
    const channelImages = await readNativeImageRows(database, [...channels.values()].map(item => item.Id));
    const programIds = series ? [] : [...new Set(rows.filter(row => present(text(row.programId))).map(row => row.programInternalId))];
    const programs = programIds.length ? await this.loadProgramDtos(database, programIds) : new Map();
    const selectors = rows.map((row, index) => ({ row, index })).filter(({ row }) => series
      || programs.has(idKey(row.programInternalId)) && present(text(row.seriesTimerId)));
    const pictures = await this.#pictures(database, selectors, series);
    return rows.map((row, index) => {
      const dto = { ...row.dto, Id: row.internalId, Type: series ? 'SeriesTimer' : 'Timer', ServerId: this.serverId,
        ExternalId: text(row.id), Name: text(row.name), Overview: text(row.overview), ServiceName: 'Emby',
        ExternalChannelId: text(row.channelId), ExternalProgramId: text(row.programId),
        ChannelId: series && !present(text(row.channelId)) ? dtoId(EMPTY_ID) : row.channelInternalId };
      if (present(text(row.programId))) dto.ProgramId = row.programInternalId;
      const channel = present(text(row.channelId)) && channels.get(idKey(row.channelInternalId));
      if (channel) dto.ChannelName = channel.Name;
      if (series) {
        if (row.dto.Days === null) throw libraryError(500, 'The saved series timer days are null.');
        dto.Days = [...row.dto.Days];
        dto.DayPattern = liveTvDayPattern(dto.Days);
        dto.ImageTags = new Map();
        Object.assign(dto, pictures.get(index));
      } else {
        dto.ExternalSeriesTimerId = text(row.seriesTimerId);
        dto.SeriesTimerId = present(dto.ExternalSeriesTimerId) ? row.seriesTimerInternalId : null;
        dto.RunTimeTicks = dateTicks(row.endDate) - dateTicks(row.startDate);
        if (channel) {
          const primary = channelImages.find(image => idKey(image.ItemId) === idKey(channel.Id) && image.ImageType === 0);
          if (primary) try { dto.ChannelPrimaryImageTag = imageTagAndBlurHash({}, channel, primary); }
          catch (error) { this.#report(error); }
        }
        const program = programs.get(idKey(row.programInternalId));
        if (program && present(dto.ExternalProgramId)) {
          dto.ProgramInfo = cloneNativeValue(program);
          if (!['Cancelled', 'Error'].includes(row.status)) {
            dto.ProgramInfo.TimerId = dto.Id; dto.ProgramInfo.Status = row.status;
          }
          dto.ProgramInfo.SeriesTimerId = dto.SeriesTimerId;
          if (present(dto.ExternalSeriesTimerId)) Object.assign(dto.ProgramInfo, pictures.get(index));
        }
      }
      return dto;
    });
  }

  async #pictures(database, requests, series) {
    if (!requests.length) return new Map();
    const select = async queries => {
      if (!queries.length) return [];
      const plans = [], values = [];
      for (const { index, slot, ...query } of queries) {
        const plan = buildPostgresItemPageQuery(database, { ...query, limit: 1 });
        const offset = values.length;
        values.push(...plan.values);
        plans.push(`SELECT ${index}::integer AS request, '${slot}'::text AS slot, selected."Id" FROM (${plan.text.replace(/\$(\d+)/gu,
          (_match, number) => '$' + (Number(number) + offset))}) selected WHERE selected."Id" IS NOT NULL`);
      }
      return (await database.client.query({ text: plans.join(' UNION ALL '), values })).rows;
    };
    const programQuery = ({ row, index }) => {
      const Name = text(row.name), SeriesId = text(row.seriesId);
      return { index, slot: 'programPrimary', includeitemtypes: ['LiveTvProgram'], externalseriesid: SeriesId,
        name: present(SeriesId) ? null : Name, imagetypes: ['Primary'] };
    };
    const winners = await select(requests.flatMap(request => {
      const { row, index } = request, Name = text(row.name);
      return [{ index, slot: 'thumb', includeitemtypes: ['Series'], name: Name, imagetypes: ['Thumb'] },
        series ? { index, slot: 'seriesPrimary', includeitemtypes: ['Series'], name: Name, imagetypes: ['Primary'] }
          : programQuery(request)];
    }));
    if (series) {
      const primaryRequests = new Set(winners.filter(row => row.slot === 'seriesPrimary').map(row => row.request));
      // Native only queries the program fallback when the Series primary is
      // absent. Unused program rows must not be hydrated or fail the request.
      winners.push(...await select(requests.filter(request => !primaryRequests.has(request.index)).map(programQuery)));
    }
    const items = new Map((await loadPostgresRowsByIds(database, winners.map(row => decodeNativeTextBytes(row.Id))))
      .map(row => [idKey(row.Id), mapRecord(row)]));
    const images = await readNativeImageRows(database, [...items.values()].map(item => item.Id));
    const result = new Map();
    for (const { index } of requests) {
      const selected = new Map(winners.filter(row => row.request === index).map(row => [row.slot, items.get(idKey(decodeNativeTextBytes(row.Id)))]));
      const value = {}, thumb = selected.get('thumb');
      const primary = series ? selected.get('seriesPrimary') ?? selected.get('programPrimary') : selected.get('programPrimary');
      const first = (item, type) => item && images.find(image => idKey(image.ItemId) === idKey(item.Id) && image.ImageType === type);
      const assign = (item, image, tag, itemField, array = false) => {
        if (!image) return;
        try {
          const cacheTag = imageTagAndBlurHash({}, item, image);
          value[tag] = array ? [cacheTag] : cacheTag; value[itemField] = dtoId(item.Id);
        } catch (error) { this.#report(error); }
      };
      assign(thumb, first(thumb, 5), 'ParentThumbImageTag', 'ParentThumbItemId');
      assign(thumb, first(thumb, 2), 'ParentBackdropImageTags', 'ParentBackdropItemId', true);
      assign(primary, first(primary, 0), 'ParentPrimaryImageTag', 'ParentPrimaryImageItemId');
      if (!value.ParentBackdropImageTags?.length) assign(primary, first(primary, 2), 'ParentBackdropImageTags', 'ParentBackdropItemId', true);
      result.set(index, value);
    }
    return result;
  }

  async getNewTimerDefaults(programId) {
    if (!this.liveTv) throw new TypeError('Timer defaults require live configuration.');
    // Reserve the read before awaiting program SQL so an admitted request can
    // finish after configuration shutdown freezes new operations. Observe a
    // fast rejection immediately, but preserve native program-error priority.
    let configurationRead;
    try { configurationRead = Promise.resolve(this.liveTv.getConfiguration()); }
    catch (error) { configurationRead = Promise.reject(error); }
    void configurationRead.catch(() => {});
    const source = present(programId) ? await this.loadProgram(programId) : null;
    const configuration = await configurationRead;
    const dto = { Id: timerId(null), Type: 'SeriesTimer', ServerId: this.serverId, ExternalId: null, ChannelId: dtoId(EMPTY_ID),
      Name: source?.item.Name ?? null, Overview: null, StartDate: MIN_DATE, EndDate: MIN_DATE, ServiceName: 'Emby',
      Priority: 0, PrePaddingSeconds: Math.max(configuration.PrePaddingSeconds, 0),
      PostPaddingSeconds: Math.max(configuration.PostPaddingSeconds, 0), IsPrePaddingRequired: false, IsPostPaddingRequired: false,
      KeepUntil: 'UntilDeleted', RecordAnyTime: true, RecordAnyChannel: false, RecordNewOnly: source ? !source.item.IsRepeat : true,
      SkipEpisodesInLibrary: source ? !source.item.IsRepeat : true, KeepUpTo: 0, Days: [...days], DayPattern: 'Daily', ImageTags: new Map(),
      ExternalChannelId: null, ExternalProgramId: source?.item.ExternalId ?? null };
    if (source) {
      if (!source.item || !source.channel) throw libraryError(500, 'The timer default program or channel was not found.');
      Object.assign(dto, { Name: source.item.Name, ChannelId: source.dto.ChannelId ?? dtoId(EMPTY_ID), ChannelName: source.dto.ChannelName,
        StartDate: dateText(source.item.StartDate), Overview: source.item.Overview, ProgramId: source.dto.Id,
        ...(source.item.EndDate != null && { EndDate: dateText(source.item.EndDate) }) });
    }
    const row = { name: source?.item.Name == null ? null : Buffer.from(source.item.Name, 'utf8').toString('hex'), seriesId: null };
    Object.assign(dto, await this.store.run(async database => (await this.#pictures(database, [{ row, index: 0 }], true)).get(0)));
    return dto;
  }
}
