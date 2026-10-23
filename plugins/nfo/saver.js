import { clrTrim, clrWhitespaceCharacters } from '@mediamanager/plugin-sdk/metadata/whitespace';
import { randomUUID } from 'node:crypto';
import { networkXmlSpool, validateXmlSpoolRoot } from '@mediamanager/plugin-sdk/metadata/local-xml-sinks';
import { nativeTextSql } from '@mediamanager/plugin-sdk/database/native-text-sql';
import { decodeNativeTextBytes } from '@mediamanager/plugin-sdk/database/native-text';
import { quoteIdentifier as q } from '@mediamanager/plugin-sdk/database/model';
import { resolvePostgresSearchCollation, releasePostgresSearchCollation } from '@mediamanager/plugin-sdk/library/postgres-search-provider';
import { escapeXml } from '@mediamanager/plugin-sdk/core/xml';
import { readNfoSaveXml, writeNfoXmlNode } from './partial-xml.js';
import { nfoConfiguration } from './configuration.js';
import { formatInvariantDate } from '@mediamanager/plugin-sdk/core/invariant-date-format';

const commonTags = new Set('plot customrating lockdata dateadded title rating year sorttitle mpaa aspectratio collectionnumber tmdbid rottentomatoesid language tvcomid tagline studio genre tag runtime actor criticrating fileinfo director writer trailer premiered releasedate outline id credits originaltitle originallanguage watched playcount lastplayed art resume biography formed review style imdbid imdb_id country audiodbalbumid audiodbartistid enddate lockedfields zap2itid tvrageid musicbrainzartistid musicbrainzalbumartistid musicbrainzalbumid musicbrainzreleasegroupid tvdbid collectionitem isuserfavorite userrating countrycode'.split(' '));
const rootNames = { Movie: 'movie', Video: 'movie', MusicVideo: 'musicvideo', Series: 'tvshow', Season: 'season', Episode: 'episodedetails', MusicAlbum: 'album', MusicArtist: 'artist' };
const customTags = { Movie: ['album', 'artist', 'set', 'id'], Video: ['album', 'artist', 'set', 'id'], MusicVideo: ['album', 'artist', 'set', 'id'], Series: ['id', 'episodeguide', 'season', 'episode', 'status', 'displayorder'], Season: ['seasonnumber'], Episode: ['aired', 'season', 'episode', 'episodenumberend', 'airsafter_season', 'airsbefore_episode', 'airsbefore_season', 'displayseason', 'displayepisode', 'showtitle'], MusicAlbum: ['track', 'artist', 'albumartist'], MusicArtist: ['album', 'disbanded'] };
const sorted = (values) => (values ?? []).map((value) => clrTrim(String(value ?? ''))).sort();

function roundMinutes(ticks) {
  const n = BigInt(ticks); const denominator = 600000000n; const quotient = n / denominator; const remainder = n % denominator;
  const absolute = remainder < 0n ? -remainder : remainder;
  return absolute * 2n > denominator || absolute * 2n === denominator && quotient % 2n !== 0n ? quotient + (n < 0n ? -1n : 1n) : quotient;
}

export async function serializeNfo(item, {fileSystem, spoolRoot, configuration, existingXml, existingDocument, existingPath, logger = { error() {} }, people = [], getPeople, userData, images = [], tracks, albums, mediaStreams = [], substituteImagePath = value => value, newLine = '\r\n' } = {}) {
  const options = nfoConfiguration(configuration); const root = rootNames[item.Type];
  if (!root) throw new TypeError(`Unsupported NFO saver type: ${item.Type}`);
  const spool=await networkXmlSpool(await validateXmlSpoolRoot(spoolRoot, fileSystem), fileSystem);
  const lines={push(...values){for(const value of values){spool.writeTextSync(newLine);spool.writeTextSync(value);}}};
  try {
  spool.writeTextSync('﻿<?xml version="1.0" encoding="utf-8" standalone="yes"?>'+newLine+'<'+root+'>');
  if(getPeople)people=await getPeople(item);
  const used = new Set([...commonTags, ...customTags[item.Type]]);
  const element = (name, value, level = 1) => { if (value != null) lines.push('  '.repeat(level) + (String(value) === '' ? `<${name} />` : `<${name}>${escapeXml(value)}</${name}>`)); };
  const optional = (name, value, level) => { if (value != null && String(value).trim()) element(name, value, level); };
  const group = (name, operation) => { lines.push(`  <${name}>`); operation(); lines.push(`  </${name}>`); };
  const date = (value) => formatInvariantDate(value, options.ReleaseDateFormat);
  const stamp = (value) => String(value ?? '0001-01-01T00:00:00').replace('T', ' ').slice(0, 19);
  const isMusic = ['MusicArtist', 'MusicAlbum'].includes(item.Type);
  const isVideo = ['Movie', 'Video', 'MusicVideo', 'Episode'].includes(item.Type);
  const overview = (item.Overview ?? '').replace(/<(.|\n)*?>/g, '').trim().replaceAll('&quot;', "'");
  element(item.Type === 'MusicArtist' ? 'biography' : item.Type === 'MusicAlbum' ? 'review' : 'plot', overview);
  if (!isVideo) element('outline', overview);
  optional('customrating', item.CustomRating); element('lockdata', item.IsLocked === true); if (item.LockedFields?.length) element('lockedfields', item.LockedFields.join('|'));
  element('dateadded', stamp(item.DateCreated)); element('title', item.Name ?? ''); optional('originaltitle', item.OriginalTitle); optional('originallanguage', item.OriginalLanguage);
  for (const [type, tags] of [['Director', ['director']], ['Writer', ['writer', 'credits']]]) {
    const names = [...new Map(people.filter((person) => person.Type === type && person.Name?.trim()).map((person) => [person.Name.trim().toLowerCase(), person.Name.trim()])).values()].sort();
    for (const tag of tags) for (const name of names) element(tag, name);
  }
  for (const trailer of [...(item.RemoteTrailers ?? [])].sort((a, b) => (a.Url ?? '').localeCompare(b.Url ?? ''))) element('trailer', trailer.Url?.replace(/https:\/\/www.youtube.com\/watch\?v=/gi, 'plugin://plugin.video.youtube/play/?video_id='));
  element('rating', item.CommunityRating); element('year', item.ProductionYear); optional('sorttitle', item.ForcedSortName); optional('mpaa', item.OfficialRating); optional('aspectratio', item.AspectRatio);
  const idTags = { TmdbCollection: 'collectionnumber', Imdb: item.Type === 'Series' ? 'imdb_id' : 'imdbid', ...(item.Type === 'Series' ? {} : { Tvdb: 'tvdbid' }), Tmdb: 'tmdbid' };
  const written = new Set();
  for (const [id, tag] of Object.entries(idTags)) if (item.ProviderIds?.[id]) { element(tag, item.ProviderIds[id]); written.add(id); }
  optional('language', item.PreferredMetadataLanguage); optional('countrycode', item.PreferredMetadataCountryCode);
  if (item.PremiereDate && item.Type !== 'Episode') {
    if (item.Type === 'MusicArtist') element('formed', date(item.PremiereDate));
    else { element('premiered', date(item.PremiereDate)); element('releasedate', date(item.PremiereDate)); }
  }
  if (item.EndDate && item.Type !== 'Episode') element('enddate', date(item.EndDate));
  element('criticrating', item.CriticRating); optional('displayorder', item.DisplayOrder);
  if (item.RunTimeTicks != null) element('runtime', roundMinutes(item.RunTimeTicks));
  optional('tagline', item.Tagline);
  for (const [field, tag] of [['ProductionLocations', 'country'], ['Genres', 'genre'], ['Studios', 'studio'], ['Tags', isMusic ? 'style' : 'tag']]) for (const value of sorted(item[field])) element(tag, value);
  const remainingIds = ['AudioDbArtist', 'AudioDbAlbum', 'Zap2It', 'MusicBrainzAlbum', 'MusicBrainzAlbumArtist', 'MusicBrainzArtist', 'MusicBrainzReleaseGroup', 'TvRage', ...Object.keys(item.ProviderIds ?? {}).sort()];
  for (const key of remainingIds) if (!written.has(key) && item.ProviderIds?.[key]) {
    const tag = key.toLowerCase() + 'id'; written.add(key); used.add(tag);
    if (/^[\p{L}_][\p{L}\p{N}_.:-]*$/u.test(tag)) element(tag, item.ProviderIds[key]);
  }
  if (options.SaveImagePathsInNfo) group('art', () => { const primary = images.find((image) => image.Type === 'Primary'); if (primary) element('poster', substituteImagePath(primary.Path), 2); for (const image of images.filter((image) => image.Type === 'Backdrop').sort((a, b) => a.Path.localeCompare(b.Path))) element('fanart', substituteImagePath(image.Path), 2); });
  if (options.UserId?.trim() && userData && !item.IsFolder) {
    element('isuserfavorite', userData.IsFavorite === true); element('userrating', userData.Rating); element('playcount', userData.PlayCount ?? 0); element('watched', userData.Played === true);
    if (userData.LastPlayedDate) element('lastplayed', stamp(userData.LastPlayedDate));
    group('resume', () => { element('position', Number(userData.PlaybackPositionTicks ?? 0n) / 10000000, 2); element('total', Number(item.RunTimeTicks ?? 0n) / 10000000, 2); });
  }
  if (!isMusic) for (const person of [...people].sort((a, b) => (a.SortOrder ?? 0) - (b.SortOrder ?? 0) || (a.Name ?? '').localeCompare(b.Name ?? ''))) {
    if (['Director', 'Writer'].includes(person.Type)) continue;
    group('actor', () => { optional('name', person.Name, 2); optional('role', person.Role, 2); if (person.Type && person.Type !== 'Unknown') element('type', person.Type, 2); element('sortorder', person.SortOrder, 2); if (options.SaveImagePathsInNfo) optional('thumb', substituteImagePath(person.ImagePath), 2); });
  }
  if (['Movie', 'Video', 'MusicVideo'].includes(item.Type)) {
    optional('id', item.ProviderIds?.Imdb);
    if (item.Type === 'Movie' && item.TmdbCollectionName) group('set', () => element('name', item.TmdbCollectionName, 2));
    if (item.Type === 'MusicVideo') { for (const artist of sorted(item.Artists)) element('artist', artist); optional('album', item.Album); }
  }
  if (item.Type === 'Series') {
    const tvdb = item.ProviderIds?.Tvdb;
    if (tvdb) { element('id', tvdb); lines.push(`  <episodeguide>`, `    <url cache="${escapeXml(tvdb)}.xml">http://www.thetvdb.com/api/1D62F2F90030C444/series/${escapeXml(tvdb)}/all/${escapeXml(item.PreferredMetadataLanguage || 'en')}.zip</url>`, '  </episodeguide>'); }
    element('season', -1); element('episode', -1); element('status', item.Status);
  }
  if (item.Type === 'Season') element('seasonnumber', item.IndexNumber);
  if (item.Type === 'Episode') {
    element('showtitle', item.SeriesName ?? ''); element('episode', item.IndexNumber); element('episodenumberend', item.IndexNumberEnd); element('season', item.ParentIndexNumber);
    if (item.PremiereDate) element('aired', date(item.PremiereDate));
    if (item.ParentIndexNumber == null || item.ParentIndexNumber === 0) for (const [tag, value] of [['airsafter_season', item.AirsAfterSeasonNumber], ['airsbefore_episode', item.AirsBeforeEpisodeNumber], ['airsbefore_season', item.AirsBeforeSeasonNumber], ['displayepisode', item.AirsBeforeEpisodeNumber], ['displayseason', item.AiredSeasonNumber]]) if (value !== -1) element(tag, value);
  }
  if (item.Type === 'MusicAlbum') {
    for (const artist of sorted(item.Artists)) element('artist', artist); for (const artist of sorted(item.AlbumArtists)) element('albumartist', artist);
    await writeChildren(tracks,'tracks',track=>group('track',()=>{
      if(track.ParentIndexNumber)element('disc',track.ParentIndexNumber,2);if(track.IndexNumber)element('position',track.IndexNumber,2);if(track.Name!=null&&track.Name!=='')element('title',track.Name,2);
      if(track.RunTimeTicks!=null){const seconds=BigInt(track.RunTimeTicks)/10000000n;element('duration',`${String(seconds/60n%60n).padStart(2,'0')}:${String(seconds%60n).padStart(2,'0')}`,2);}
    }));
  }
  if (item.Type === 'MusicArtist') {
    if (item.EndDate) element('disbanded', date(item.EndDate));
    await writeChildren(albums,'albums',album=>group('album',()=>{if(album.Name!=null&&album.Name!=='')element('title',album.Name,2);element('year',album.ProductionYear,2);}));
  }
  if (isVideo) {
    lines.push('  <fileinfo>');
    if (!mediaStreams.length) lines.push('    <streamdetails />');
    else {
      lines.push('    <streamdetails>');
      for (const stream of mediaStreams) {
        const tag = stream.Type.toLowerCase(); lines.push(`      <${tag}>`);
        const codec = /xvid/i.test(stream.CodecTag ?? '') ? 'xvid' : /divx/i.test(stream.CodecTag ?? '') ? 'divx' : stream.Codec;
        if (stream.Codec) { element('codec', codec, 4); element('micodec', codec, 4); }
        for (const [name, field] of [['bitrate', 'BitRate'], ['width', 'Width'], ['height', 'Height']]) element(name, stream[field], 4);
        optional('aspect', stream.AspectRatio, 4); optional('aspectratio', stream.AspectRatio, 4); element('framerate', stream.ReferenceFrameRate, 4);
        optional('language', stream.Language?.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFEFF\uFFFE\uFFFF]/g, ''), 4);
        element('scantype', stream.IsInterlaced ? 'interlaced' : 'progressive', 4); element('channels', stream.Channels, 4); element('samplingrate', stream.SampleRate, 4);
        element('default', stream.IsDefault ? 'True' : 'False', 4); element('forced', stream.IsForced ? 'True' : 'False', 4); if (stream.IsOriginal) element('original', 'True', 4);
        if (stream.Type === 'Video') {
          if (item.RunTimeTicks != null) { element('duration', BigInt(item.RunTimeTicks) / 600000000n, 4); element('durationinseconds', BigInt(item.RunTimeTicks) / 10000000n, 4); }
          element('format3d', { FullSideBySide: 'FSBS', FullTopAndBottom: 'FTAB', HalfSideBySide: 'HSBS', HalfTopAndBottom: 'HTAB', MVC: 'MVC' }[item.Video3DFormat], 4);
        }
        lines.push(`      </${tag}>`);
      }
      lines.push('    </streamdetails>');
    }
    lines.push('  </fileinfo>');
  }
  const document = existingDocument ?? (existingXml ? readNfoSaveXml(existingXml) : null);
  if (document?.error) logger.error(document.error, document.phase === 'root'
    ? `Error reading existing xml tags from ${existingPath ?? item.Path}.` : 'Error reading existing nfo');
  for (const node of document?.root?.children ?? []) if (!used.has(node.name.toLowerCase())) lines.push('  ' + writeNfoXmlNode(node, {}, newLine));
  lines.push(`</${root}>`);
  return await spool.prepare();
  } catch(error) {await spool.dispose();throw error;}

  async function writeChildren(producer,mode,write) {
    if(producer==null)return;
    if(typeof producer!=='function')throw new TypeError('NFO members require an owned sequence producer.');
    const sequence=await producer();
    let sequencePrimary;
    try {await sequence.aggregationSession(async(session,{plan})=>{
      const text=nativeTextSql(session.schemaName),collation=await resolvePostgresSearchCollation(session,new Intl.Collator().resolvedOptions().locale);
      let primaryError;
      const cleanupErrors=[];
      try {
      const trim="'"+clrWhitespaceCharacters.replaceAll("'","''")+"'";
      const culture=value=>`replace(replace(${value},chr(1)||'0',''),chr(1)||'1','') COLLATE ${q(collation.schema)}.${q(collation.name)}`;
      const name=`btrim(${text.projection('"Name"')},${trim})`,sort=`COALESCE(NULLIF(btrim(${text.projection('"SortName"')},${trim}),''),${name},'')`;
      const nameSort=culture(name),sortValue=culture(sort);
      const order=mode==='tracks'?`COALESCE("ParentIndexNumber",0),COALESCE("IndexNumber",0),${sortValue},${nameSort} NULLS FIRST,"Ordinal"`:`COALESCE("ProductionYear",0),${sortValue},${nameSort} NULLS FIRST,"Ordinal"`;
      const ordered=q('mm_nfo_members_'+randomUUID().replaceAll('-',''));
      try {
        await session.client.query(`CREATE TEMP TABLE ${ordered} AS WITH source AS (${plan.text}) SELECT source.*,row_number() OVER(ORDER BY ${order}) AS position FROM source`);
        await session.client.query(`CREATE UNIQUE INDEX ON ${ordered}(position)`);
        for(let after=0n;;){
          const page=(await session.client.query(`SELECT * FROM ${ordered} WHERE position>$1 ORDER BY position LIMIT 128`,[after])).rows;
          if(!page.length)break;
          for(const row of page)write({...row,Name:row.Name==null?null:decodeNativeTextBytes(row.Name)});
          after=BigInt(page.at(-1).position);
        }
      } catch(error) {primaryError=error;throw error;}
      finally {
        try {await session.client.query(`DROP TABLE IF EXISTS ${ordered}`);}
        catch(error) {if(!(primaryError && session.inTransaction && error.code==='25P02')){cleanupErrors.push(error);session.discardConnection(error);}}
      }
      } catch(error) {primaryError ??= error;throw error;}
      finally {await releasePostgresSearchCollation(collation,primaryError,cleanupErrors);}
    });} catch(error) {sequencePrimary=error;throw error;}
    finally {
      try {await sequence.close();}
      catch(cleanupError) {
        if(sequencePrimary)throw new AggregateError([sequencePrimary,cleanupError],sequencePrimary.message,{cause:sequencePrimary});
        throw cleanupError;
      }
    }
  }
}
