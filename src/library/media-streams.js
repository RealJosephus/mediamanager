import { withNativeFloats } from '../core/json.js';
import { readFileSync } from 'node:fs';

const cultures = readFileSync(new URL('./resources/iso6392.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
  const [term, bibliographic, short, display] = line.split('|');
  return { term, bibliographic, short, display, name: short.includes('-') ? short : display, codes: bibliographic ? [term, bibliographic] : [term] };
});
const phrases = JSON.parse(readFileSync(new URL('./resources/stream-phrases.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const types = ['Audio', 'Video', 'Subtitle', 'EmbeddedImage', 'Data', 'Lyric'];
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const contains = (value, fragment) => (value ?? '').toLowerCase().includes(fragment.toLowerCase());
const firstUpper = value => value ? value[0].toUpperCase() + value.slice(1) : value;
const culture = value => value ? cultures.find(entry => [entry.display, entry.name, entry.short, ...entry.codes].some(name => equal(name, value))) : undefined;
export const normalizeLanguage = value => !value ? [] : culture(value)?.name.includes('-') ? [culture(value).name] : culture(value)?.codes ?? [value];

function localized(key, options) {
  const selected = options.localization?.context.uiCulture || options.culture || options.configuration?.UICulture || 'en-US';
  const name = Object.keys(phrases).find(name => equal(name.replaceAll('_', '-'), selected));
  return phrases[name]?.[key] ?? phrases['en-US'][key] ?? key;
}

export function videoColorRange(stream) {
  if (stream.Type !== 'Video') return ['Unknown', 'Unknown'];
  const pq = equal(stream.ColorTransfer, 'smpte2084'), hlg = equal(stream.ColorTransfer, 'arib-std-b67');
  const base = pq || hlg ? 'HDR' : 'SDR';
  const profile = stream.DvProfile, compatibility = stream.DvBlSignalCompatibilityId;
  if (([5, 7, 8, 10].includes(profile) && stream.RpuPresentFlag === 1 && stream.BlPresentFlag === 1 && [0, 1, 4, 2, 6].includes(compatibility)) || ['dovi', 'dvh1', 'dvhe', 'dav1'].some(tag => equal(tag, stream.CodecTag))) {
    let range = ['SDR', 'SDR'];
    if (profile === 5) range = ['HDR', 'DOVI'];
    else if (profile === 7) range = ['HDR', 'DOVIWithEL'];
    else if ([8, 10].includes(profile)) range = ({ 0: profile === 10 ? ['HDR', 'DOVI'] : [base, 'DOVIInvalid'], 1: ['HDR', 'DOVIWithHDR10'], 2: ['SDR', 'DOVIWithSDR'], 4: ['HDR', 'DOVIWithHLG'] })[compatibility] ?? [base, 'DOVIInvalid'];
    const transfer = ['DOVIWithHDR10', 'DOVIWithEL'].includes(range[1]) ? 'smpte2084' : range[1] === 'DOVIWithHLG' ? 'arib-std-b67' : null;
    if (transfer && (!equal(stream.ColorSpace, 'bt2020nc') || !equal(stream.ColorTransfer, transfer) || !equal(stream.ColorPrimaries, 'bt2020'))) return [base, 'DOVIInvalid'];
    if (stream.Hdr10PlusPresentFlag) {
      if (range[1] === 'DOVIWithHDR10') range[1] = 'DOVIWithHDR10Plus';
      if (range[1] === 'DOVIWithEL') range[1] = 'DOVIWithELHDR10Plus';
    }
    return range;
  }
  return pq ? ['HDR', stream.Hdr10PlusPresentFlag ? 'HDR10Plus' : 'HDR10'] : hlg ? ['HDR', 'HLG'] : ['SDR', 'SDR'];
}

function resolution(stream) {
  if (stream.Width == null || stream.Height == null) return null;
  const dimensions = [[256, 144, '144'], [426, 240, '240'], [640, 360, '360'], [682, 384, '384'], [720, 404, '404'], [854, 480, '480'], [960, 544, '540'], [1024, 576, '576'], [1280, 962, '720'], [2560, 1440, '1080'], [4096, 3072, '4K'], [8192, 6144, '8K']];
  const label = dimensions.find(([width, height]) => stream.Width <= width && stream.Height <= height)?.[2];
  return label ? label.endsWith('K') ? label : label + (stream.IsInterlaced ? 'i' : 'p') : null;
}

function displayTitle(stream) {
  const attributes = [];
  if (stream.Type === 'Audio') {
    if (stream.Language && !['mis', 'mul', 'und', 'zxx'].some(code => equal(code, stream.Language))) attributes.push(firstUpper(stream.LocalizedLanguage ?? stream.Language));
    if (stream.Profile && !equal(stream.Profile, 'lc')) attributes.push(stream.Profile);
    else if (stream.Codec) attributes.push(({ ac3: 'Dolby Digital', eac3: 'Dolby Digital+', dca: 'DTS' })[stream.Codec.toLowerCase()] ?? stream.Codec.toUpperCase());
    if (stream.ChannelLayout) attributes.push(firstUpper(stream.ChannelLayout));
    else if (stream.Channels != null) attributes.push(`${stream.Channels} ch`);
    for (const name of ['Default', 'External', 'Original']) if (stream[`Is${name}`]) attributes.push(stream[`Localized${name}`]);
  } else if (stream.Type === 'Video') {
    const size = resolution(stream); if (size) attributes.push(size);
    if (stream.Codec) attributes.push(stream.Codec.toUpperCase());
    if (stream.VideoDoViTitle) attributes.push(stream.VideoDoViTitle);
    else if (stream.VideoRange !== 'Unknown') attributes.push(stream.VideoRange);
  } else if (stream.Type === 'Subtitle') {
    attributes.push(stream.Language ? firstUpper(stream.LocalizedLanguage ?? stream.Language) : stream.LocalizedUndefined);
    for (const name of ['HearingImpaired', 'Default', 'Forced']) if (stream[`Is${name}`]) attributes.push(stream[`Localized${name}`]);
    if (stream.Codec) attributes.push(stream.Codec.toUpperCase());
    if (stream.IsExternal) attributes.push(stream.LocalizedExternal);
  } else return undefined;
  return stream.Title ? [stream.Title, ...attributes.filter(tag => !contains(stream.Title, tag))].join(' - ') : attributes.join(stream.Type === 'Video' ? ' ' : ' - ');
}

export function projectStream(row, options = {}) {
  const stream = { Index: row.StreamIndex, Type: types[row.StreamType] ?? row.StreamType, IsAVC: row.IsAvc };
  const columns = ['Codec', 'Language', 'ChannelLayout', 'Profile', 'AspectRatio', 'Path', 'BitRate', 'Channels', 'SampleRate', 'Height', 'Width', 'AverageFrameRate', 'RealFrameRate', 'Level', 'PixelFormat', 'BitDepth', 'IsAnamorphic', 'RefFrames', 'CodecTag', 'Comment', 'NalLengthSize', 'Title', 'TimeBase', 'CodecTimeBase', 'ColorPrimaries', 'ColorSpace', 'ColorTransfer', 'DvVersionMajor', 'DvVersionMinor', 'DvProfile', 'DvLevel', 'RpuPresentFlag', 'ElPresentFlag', 'BlPresentFlag', 'DvBlSignalCompatibilityId', 'Rotation', 'Hdr10PlusPresentFlag'];
  for (const name of columns) stream[name] = row[name];
  for (const name of ['IsDefault', 'IsForced', 'IsExternal', 'IsOriginal', 'IsInterlaced', 'IsHearingImpaired']) stream[name] = Boolean(row[name]);
  if (stream.Path && options.expandPath) stream.Path = options.expandPath(stream.Path);
  const translated = cultures.find(entry => entry.bibliographic && equal(entry.bibliographic, stream.Language));
  if (translated) stream.Language = translated.term;
  if (['Audio', 'Subtitle'].includes(stream.Type)) {
    for (const name of ['Default', 'External', ...(stream.Type === 'Audio' ? ['Original'] : ['Undefined', 'Forced', 'HearingImpaired'])]) stream[`Localized${name}`] = localized(name, options);
    if (stream.Language) stream.LocalizedLanguage = culture(stream.Language)?.display.split(/[;,]/)[0].trim();
  }
  [stream.VideoRange, stream.VideoRangeType] = videoColorRange(stream);
  if (stream.RpuPresentFlag === 1 && stream.BlPresentFlag === 1 && [4, 5, 7, 8, 9, 10].includes(stream.DvProfile)) {
    const compatibility = stream.DvBlSignalCompatibilityId;
    stream.VideoDoViTitle = `Dolby Vision Profile ${stream.DvProfile}${compatibility > 0 ? `.${compatibility}` : ''}${({ 1: ' (HDR10)', 2: ' (SDR)', 4: ' (HLG)', 6: ' (HDR10)' })[compatibility] ?? ''}`;
  }
  stream.AudioSpatialFormat = stream.Type === 'Audio' && contains(stream.Profile, 'Dolby Atmos') ? 'DolbyAtmos' : stream.Type === 'Audio' && contains(stream.Profile, 'DTS:X') ? 'DTSX' : 'None';
  stream.ReferenceFrameRate = stream.AverageFrameRate != null && stream.AverageFrameRate < 1000 ? stream.AverageFrameRate : stream.RealFrameRate;
  const codec = (stream.Codec ?? '').toLowerCase();
  stream.IsTextSubtitleStream = stream.Type === 'Subtitle' && (Boolean(codec) || stream.IsExternal) && (codec.includes('microdvd') || (!['pgs', 'dvdsub', 'vobsub', 'dvbsub'].some(value => codec.includes(value)) && !['sup', 'sub'].includes(codec)));
  stream.SupportsExternalStream = stream.IsExternal || stream.IsTextSubtitleStream || (stream.Type === 'Subtitle' && (['pgs', 'dvdsub', 'vobsub'].some(value => codec.includes(value)) || codec === 'sup'));
  stream.DisplayTitle = displayTitle(stream);
  return withNativeFloats(stream, ['AverageFrameRate', 'RealFrameRate', 'ReferenceFrameRate']);
}

export async function loadStreams(db, item, options, prefetchedRows) {
  const rows = prefetchedRows ?? await db.rows('MediaStreamInfos', { where: { ItemId: item.Id } });
  return [...rows].sort((a, b) => a.StreamIndex - b.StreamIndex).map(row => projectStream(row, options));
}

const matches = (language, preferences) => preferences.length === 0 || preferences.some(value => equal(value, language));
const undefinedLanguage = language => !language || ['und', 'unknown', 'undetermined', 'mul', 'zxx'].some(value => equal(value, language));
export function streamScore(stream, preferences) {
  const index = preferences.findIndex(value => equal(value, stream.Language));
  let score = index < 0 ? 1 : 101 - index;
  for (const flag of [stream.IsForced, stream.IsDefault, stream.SupportsExternalStream, stream.IsTextSubtitleStream, stream.IsExternal]) score = score * 10 + (flag ? 2 : 1);
  return score;
}
const forcedStreams = (streams, preferred) => streams.filter(stream => stream.IsForced && (matches(stream.Language, preferred) || undefinedLanguage(stream.Language))).sort((a, b) => Number(matches(b.Language, preferred)) - Number(matches(a.Language, preferred)) || Number(undefinedLanguage(b.Language)) - Number(undefinedLanguage(a.Language)));
const defaultAudio = (streams, preferred, preferDefault) => {
  const audio = streams.filter(stream => stream.Type === 'Audio').sort((a, b) => streamScore(b, preferred) - streamScore(a, preferred));
  return (preferDefault ? audio.find(stream => stream.IsDefault) ?? audio[0] : audio[0])?.Index;
};

export function selectDefaultTracks(source, item, user, data = {}, originalLanguage = item.OriginalLanguage) {
  const streams = source.MediaStreams;
  Object.defineProperty(source, 'DefaultAudioIndexSource', { value: source.DefaultAudioIndexSource ?? 0, writable: true, configurable: true, enumerable: false });
  if (item.MediaType === 'Audio') { source.DefaultAudioStreamIndex = streams.find(stream => stream.Type === 'Audio')?.Index; return; }
  if (item.MediaType !== 'Video') return;
  const config = { ...user.Configuration, ...user };
  const allowRemembering = item.EnableRememberingTrackSelections !== false;
  const original = equal(config.AudioLanguagePreference, 'OriginalLanguage');
  const audioPreferred = normalizeLanguage(original && originalLanguage?.trim() ? originalLanguage : config.AudioLanguagePreference);
  if (allowRemembering && config.RememberAudioSelections && data.AudioStreamIndex != null && streams.some(stream => stream.Type === 'Audio' && stream.Index === data.AudioStreamIndex)) {
    source.DefaultAudioStreamIndex = data.AudioStreamIndex;
    source.DefaultAudioIndexSource = 4;
  }
  else {
    const originalIndex = streams.findIndex(stream => stream.Type === 'Audio' && stream.IsOriginal);
    if (original && config.PlayDefaultAudioTrack) source.DefaultAudioStreamIndex = defaultAudio(streams, normalizeLanguage(originalLanguage), true);
    else if (original && originalIndex >= 0 && (!originalLanguage?.trim() || normalizeLanguage(streams[originalIndex].Language).includes(normalizeLanguage(originalLanguage)[0]))) source.DefaultAudioStreamIndex = originalIndex;
    else {
      source.DefaultAudioStreamIndex = defaultAudio(streams, audioPreferred, config.PlayDefaultAudioTrack);
      if (config.PlayDefaultAudioTrack) source.DefaultAudioIndexSource |= 1;
      if (audioPreferred.length) source.DefaultAudioIndexSource |= 2;
    }
  }
  const mode = typeof config.SubtitleMode === 'number' ? ['Default', 'Always', 'OnlyForced', 'None', 'Smart'][config.SubtitleMode] : config.SubtitleMode ?? 'Default';
  const savedSubtitle = streams.find(stream => stream.Type === 'Subtitle' && stream.Index === data.SubtitleStreamIndex);
  if (allowRemembering && config.RememberSubtitleSelections && mode !== 'None' && data.SubtitleStreamIndex != null && (data.SubtitleStreamIndex === -1 || savedSubtitle && (mode !== 'OnlyForced' || savedSubtitle.IsForced))) { source.DefaultSubtitleStreamIndex = data.SubtitleStreamIndex; return; }
  if (mode === 'None') return;
  const preferred = normalizeLanguage(config.SubtitleLanguagePreference);
  const audioLanguage = streams.find(stream => stream.Type === 'Audio' && stream.Index === source.DefaultAudioStreamIndex)?.Language;
  const subtitles = streams.filter(stream => stream.Type === 'Subtitle');
  const flags = stream => [stream.IsExternal, stream.IsDefault, !stream.IsForced && matches(stream.Language, preferred), stream.IsForced && matches(stream.Language, preferred), stream.IsForced && undefinedLanguage(stream.Language), stream.IsForced];
  const sorted = [...subtitles].sort((a, b) => { const left = flags(a), right = flags(b); for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return Number(right[index]) - Number(left[index]); return 0; });
  const audioMatches = preferred.some(value => equal(value, audioLanguage));
  const filtered = values => mode === 'Default' ? values.filter(stream => stream.IsExternal || stream.IsDefault || stream.IsForced) : mode === 'Smart' && !audioMatches ? values.filter(stream => matches(stream.Language, preferred)) : mode === 'Always' ? values.filter(stream => !stream.IsForced && matches(stream.Language, preferred)) : forcedStreams(values, preferred);
  const candidates = filtered(sorted);
  source.DefaultSubtitleStreamIndex = (candidates[0] ?? (mode === 'Always' ? forcedStreams(sorted, preferred)[0] : undefined))?.Index;
  for (const stream of filtered(subtitles)) stream.Score = streamScore(stream, preferred);
}
