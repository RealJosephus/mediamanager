import { EOL } from 'node:os';
import { escapeXml } from '../core/xml.js';
import { nativeGuid } from '../users/native.js';
import { imagePathApi } from '../metadata/image-assets.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { guideProgramId } from './live-tv-guide-program.js';

const text = value => typeof value === 'string' && value.trim() ? value : undefined;
const providerId = (program, name) => {
  const ids = program ?? {}, entries = ids instanceof Map ? [...ids] : Object.entries(ids);
  return entries.find(([key]) => ordinalIgnoreCaseEquals(key, name))?.[1];
};
const hasTag = (timer, name) => timer.Tags?.some(tag => ordinalIgnoreCaseEquals(tag, name));
const fields = (name, values) => (values ?? []).map(value => [name, value]);

function localDate(value, format) {
  const date = new Date(value);
  const replacements = { yyyy: String(date.getFullYear()).padStart(4, '0'), yy: String(date.getFullYear()).slice(-2),
    MM: String(date.getMonth() + 1).padStart(2, '0'), M: date.getMonth() + 1,
    dd: String(date.getDate()).padStart(2, '0'), d: date.getDate() };
  return (format || 'yyyy-MM-dd').replace(/'([^']*)'|"([^"]*)"|\\(.)|yyyy|yy|MM|M|dd|d/gu,
    (token, single, double, escaped) => single ?? double ?? escaped ?? replacements[token]);
}

function nfoDocument(element, values) {
  const declaration = '\ufeff<?xml version="1.0" encoding="utf-8" standalone="yes"?>';
  const body = values.filter(([, value]) => value != null).map(([name, value]) => value === '' ? `  <${name} />`
    : `  <${name}>${escapeXml(value).replaceAll(/\r\n|\r|\n/gu, EOL)}</${name}>`);
  return Buffer.from([declaration, `<${element}>`, ...body, `</${element}>`].join(EOL));
}

async function createNfo(fileSystem, filename, element, values) {
  try { await fileSystem.writeFile(filename, nfoDocument(element, values), { flag: 'wx' }); }
  catch (error) { if (!['EEXIST', 'already-exists'].includes(error.code)) throw error; }
}

export async function saveRecordingAssets({ timer, filename, seriesPath, configuration, releaseDateFormat,
  library, fileSystem, downloadImage, signal, onError }) {
  if (!configuration.SaveRecordingNFO && !configuration.SaveRecordingImages) return;
  const guide = timer.ProgramId ? await library.itemCreation.getItemById(nativeGuid(guideProgramId(timer.ProgramId))) : null;
  const program = guide ?? { ...timer, PremiereDate: timer.OriginalAirDate, IndexNumber: timer.EpisodeNumber, ParentIndexNumber: timer.SeasonNumber };
  const api = imagePathApi(filename), destination = api.dirname(filename), stem = api.basename(filename, api.extname(filename));
  const sports = hasTag(timer, 'Sports'), kids = hasTag(timer, 'Kids'), news = hasTag(timer, 'News');
  if (configuration.SaveRecordingNFO) {
    const genres = [...(program.Genres ?? [])];
    for (const genre of [sports && 'Sports', kids && 'Kids', kids && 'Children', news && 'News'].filter(Boolean)) {
      if (!genres.some(value => ordinalIgnoreCaseEquals(value, genre))) genres.push(genre);
    }
    if (seriesPath) {
      await createNfo(fileSystem, api.join(seriesPath, 'tvshow.nfo'), 'tvshow', [
        ['id', providerId(timer.SeriesProviderIds, 'Tvdb')], ['imdb_id', providerId(timer.SeriesProviderIds, 'Imdb')],
        ['tmdbid', providerId(timer.SeriesProviderIds, 'Tmdb')], ['zap2itid', providerId(timer.SeriesProviderIds, 'Zap2It')],
        ['title', text(timer.Name)], ['mpaa', text(timer.OfficialRating)], ...fields('genre', timer.Genres),
      ]);
    }
    const now = new Date();
    const airDate = program.PremiereDate ? localDate(program.PremiereDate, releaseDateFormat)
      : seriesPath && !timer.IsRepeat ? localDate(now, releaseDateFormat) : undefined;
    const overview = (program.Overview ?? '').replace(/<[^>]*>/gu, '').replaceAll('&quot;', "'");
    const imdb = providerId(program.ProviderIds, 'Imdb'), tvdb = providerId(program.ProviderIds, 'Tvdb'), tmdb = providerId(program.ProviderIds, 'Tmdb');
    const lock = !seriesPath && (!timer.IsMovie || sports || news) && !imdb && !tvdb && !tmdb;
    const content = seriesPath ? [
      ['title', text(timer.EpisodeTitle)], ['aired', airDate], ['episode', program.IndexNumber], ['season', program.ParentIndexNumber],
    ] : [['title', text(program.Name)], ['originaltitle', text(program.OriginalTitle)], ['premiered', airDate], ['releasedate', airDate]];
    await createNfo(fileSystem, api.join(destination, stem + '.nfo'), seriesPath ? 'episodedetails' : 'movie', [
      ...content, ['dateadded', now.toISOString().slice(0, 19).replace('T', ' ')], ['year', program.ProductionYear],
      ['mpaa', text(program.OfficialRating)], ['plot', overview], ['rating', program.CommunityRating], ...fields('genre', genres),
      ['collectionnumber', providerId(program.ProviderIds, 'TmdbCollection')], ['id', seriesPath ? undefined : imdb], ['imdbid', imdb],
      ['tvdbid', tvdb], ['tmdbid', tmdb], ['lockdata', lock ? 'true' : undefined], ['criticrating', program.CriticRating],
      ['tagline', text(program.Tagline)], ...fields('studio', program.Studios),
    ]);
  }
  if (!configuration.SaveRecordingImages) return;
  const image = type => program.ImageInfos?.find(value => value.Type === type);
  const candidates = program.IsSeries ? [image('Thumb') ?? image('Primary')]
    : [image('Primary') ?? image('Thumb'), image('Backdrop'), image('Thumb'), image('Logo')];
  const names = { Primary: 'poster', Thumb: 'landscape', Backdrop: 'fanart', Logo: 'logo' };
  for (const { Type, Path } of new Set(candidates.filter(value => value?.Path))) {
    signal?.throwIfAborted();
    const base = program.IsSeries ? stem + '-thumb' : names[Type];
    try {
      if (/^https?:\/\//iu.test(Path)) {
        const { bytes, mimeType } = await downloadImage(Path, signal);
        const extension = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[mimeType] ?? '.jpg';
        await fileSystem.writeFile(api.join(destination, base + extension), bytes, { signal });
      } else await fileSystem.copyFile(Path, api.join(destination, base + (imagePathApi(Path).extname(Path) || '.jpg')));
    } catch (error) { onError?.(error); }
  }
}
