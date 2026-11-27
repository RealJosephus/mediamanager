import { dateTicks } from '@mediamanager/plugin-sdk/library/records';

// SchedulesDirect.GetScheduleRequestDates covers both local and UTC calendar dates.
const day = 86400000;
function datesFor(start, end) {
  function bounds(input) {
    const date = new Date(input);
    return [date.toISOString().slice(0, 10), new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)].sort();
  }
  const dates = [], first = Date.parse(bounds(start)[0]), last = Date.parse(bounds(end)[1]);
  for (let date = first; date <= last; date += day) dates.push(new Date(date).toISOString().slice(0, 10));
  return dates;
}
function program(station, airing, detail, images) {
  const start = airing.airDateTime, id = airing.programID, series = detail.entityType?.toLowerCase() === 'episode' || /^SH.{12}/iu.test(id);
  const Id = id + 'T' + dateTicks(start) + 'C' + station;
  const audio = (airing.audioProperties ?? []).map(s => s.toLowerCase());
  const video = (airing.videoProperties ?? []).map(s => s.toLowerCase());
  const genres = (detail.genres ?? []).filter(g => g.trim());
  const rating = detail.contentRating?.[0]?.code?.replaceAll('TV', 'TV-').replaceAll('--', '-');
  const meta = detail.metadata?.find(value => value.Gracenote || value.gracenote);
  const episode = meta?.Gracenote ?? meta?.gracenote;
  const seriesId = series ? id.slice(0, 10) : null;
  const year = Number(detail.movie?.year) || Number(detail.originalAirDate?.slice(0, 4)) || null;
  return {
    Id, ChannelId: station, ShowId: /^SH.*0000$/iu.test(id) ? Id : id, Name: detail.titles?.[0]?.title120 ?? 'Unknown',
    StartDate: start, EndDate: new Date(Date.parse(start) + airing.duration * 1000).toISOString(),
    EpisodeTitle: detail.episodeTitle150, SeriesId: seriesId, ProviderIds: {}, SeriesProviderIds: series ? { Zap2It: seriesId } : {},
    OriginalAirDate: detail.originalAirDate, ProductionYear: year, SeasonNumber: series ? episode?.season : null,
    EpisodeNumber: series && episode?.episode > 0 ? episode.episode : null,
    Overview: detail.descriptions?.description1000?.[0]?.description ?? detail.descriptions?.description100?.[0]?.description,
    Genres: genres, OfficialRating: /^(?:N\/A|Approved|Not Rated|Passed)$/iu.test(rating) ? null : rating,
    IsRepeat: airing.new == null, IsSeries: series, IsMovie: detail.entityType?.toLowerCase() === 'movie',
    IsSports: detail.entityType?.toLowerCase() === 'sports', IsLive: airing.liveTapeDelay?.toLowerCase() === 'live',
    IsKids: detail.audience?.toLowerCase() === 'children' || genres.some(value => value.toLowerCase() === 'children'),
    IsNews: genres.some(value => value.toLowerCase() === 'news'), IsHD: video.includes('hdtv'), Is3D: video.includes('3d'),
    Audio: audio.includes('atmos') ? 'Atmos' : audio.some(value => value === 'dd' || value === 'dd 5.1') ? 'DolbyDigital'
      : !audio.length || audio.includes('stereo') ? 'Stereo' : 'Mono',
    IsPremiere: Boolean(airing.premiere || /premiere/iu.test(airing.isPremiereOrFinale)), Etag: airing.md5, ...images,
  };
}
async function artwork(entries, { api, token, imagePolicy }) {
  const images = [];
  for (const image of entries) {
    if (!image.uri?.trim()) continue;
    const absolute = /^https?:\/\//iu.test(image.uri);
    if (!absolute && !token) continue;
    const url = absolute ? image.uri : api + '/image/' + image.uri + '?token=' + encodeURIComponent(token);
    if (!imagePolicy?.canDownloadImage || await imagePolicy.canDownloadImage(url)) images.push({ ...image, url });
  }
  const withText = images.filter(value => value.text?.toLowerCase() === 'yes');
  function best(list, aspect) {
    const distance = value => Math.abs(aspect - (Number(value.width) / Number(value.height) || 0));
    const match = list.filter(value => value.uri?.trim()).sort((a, b) => distance(a) - distance(b) || Number(b.height) - Number(a.height))[0];
    return match?.url ?? null;
  }
  const ImageUrl = best(withText, 2 / 3) ?? best(images, 2 / 3), thumb = best(withText, 16 / 9);
  return { ImageUrl, ThumbImageUrl: thumb === ImageUrl ? null : thumb };
}

export async function getSchedulePrograms(station, start, end, client) {
  const { post, cacheName, readCache, writeCache, signal, applyCode, now, retryTimes } = client;
  const dates = datesFor(start, end);
  const request = date => [{ stationID: station, date }];
  let hashes = {};
  try { hashes = (await post('/schedules/md5', request(dates)))?.[station] ?? {}; }
  catch { signal?.throwIfAborted(); }
  const days = new Map(), missing = [], previous = new Map();
  const filename = date => cacheName('schedules', station, date);
  for (const [key, until] of retryTimes) if (until <= now()) retryTimes.delete(key);
  for (const date of dates) {
    const hash = hashes[date];
    if ([7020, 7030, 2200, 2201].includes(hash?.code)) continue;
    if (hash?.code) await applyCode(hash.code);
    const cached = await readCache(filename(date));
    if (cached?.Schedule) previous.set(date, cached);
    if (hash?.md5 && hash.md5 === cached?.Md5) days.set(date, cached);
    else if (!retryTimes.has(station + '|' + date)) missing.push(date);
  }
  if (missing.length) {
    const payload = await post('/schedules', request(missing));
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) if (row?.code) {
      await applyCode(row.code);
      if (row.code === 7100 && row.retryTime) for (const date of missing) retryTimes.set(station + '|' + date, Date.parse(row.retryTime));
    }
    const fresh = rows.filter(row => row && row.code == null && missing.includes(row.metadata?.startDate));
    const ids = [...new Set(fresh.flatMap(row => row.programs.map(airing => airing.programID)).filter(Boolean))];
    const details = new Map();
    for (let index = 0; index < ids.length; index += 5000) {
      for (const detail of await post('/programs', ids.slice(index, index + 5000)) ?? []) {
        if (detail.code) await applyCode(detail.code);
        else if (detail.programID) details.set(detail.programID, detail);
      }
    }
    for (const row of fresh) {
      const date = row.metadata.startDate, dayIds = [...new Set(row.programs.map(airing => airing.programID).filter(Boolean))];
      const programs = dayIds.map(id => details.get(id) ?? previous.get(date)?.Programs?.find(value => value.programID === id));
      if (!programs.every(Boolean)) continue;
      const result = { Md5: row.metadata.md5, Schedule: row, Programs: programs };
      if (result.Md5 && dayIds.every(id => details.has(id))) await writeCache(filename(date), result);
      days.set(date, result);
    }
  }
  for (const date of dates) {
    if (days.has(date) || [7020, 7030, 2200, 2201].includes(hashes[date]?.code)) continue;
    if (!previous.has(date)) throw new Error('Could not get the schedule for station ' + station + ' on ' + date);
    days.set(date, previous.get(date));
  }
  signal?.throwIfAborted();
  await client.pruneScheduleCache(station, dates);
  const details = new Map([...days.values()].flatMap(row => row.Programs).map(detail => [detail.programID, detail]));
  const airings = [...days.values()].flatMap(row => row.Schedule.programs).filter(row => row.airDateTime && details.has(row.programID));
  const near = row => Date.parse(row.airDateTime) + row.duration * 1000 < now() + 2 * day;
  const ids = [...new Set(airings.filter(row => near(row) && details.get(row.programID).hasImageArtwork).map(row => row.programID))];
  const images = [];
  for (let index = 0; index < ids.length; index += 500) {
    if (await client.imagePolicy?.isImageDailyLimitActive()) break;
    try {
      for (const entry of await post('/metadata/programs/', ids.slice(index, index + 500)) ?? []) {
        if (entry.code) await applyCode(entry.code);
        else if (entry.programID) images.push(entry);
      }
    } catch { signal?.throwIfAborted(); }
  }
  const byProgram = new Map();
  if (images.length) {
    const token = await client.getToken();
    for (const entry of images) byProgram.set(entry.programID, await artwork(entry.data ?? [], { ...client, token }));
  }
  return airings.map(row => program(station, row, details.get(row.programID),
    near(row) ? byProgram.get(images.find(entry => row.programID.startsWith(entry.programID))?.programID) : {}));
}
