import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ordinalIgnoreCaseEquals as same, ordinalIgnoreCaseKey } from './ordinal-comparer.js';
import { normalizeProbe } from './probe-normalizer.js';
import { checkAbort } from './errors.js';

const subtitleExtensions = new Set('.ass .mks .sami .smi .srt .ssa .sub .sup .vtt .idx'.split(' '));
const lyricExtensions = new Set(['.lrc', '.elrc', '.txt']);
const audioExtensions = new Set('.669 .3gp .aa .aac .aax .ac3 .act .adp .adplug .adx .afc .amf .aif .aifc .aiff .alac .amr .ape .ast .au .awb .cda .cue .dmf .dsf .dsm .dsp .dts .dvf .eac3 .ec3 .far .flac .gdm .gsm .gym .hps .imf .it .m15 .m4a .m4b .mac .med .mka .mmf .mod .mogg .mp2 .mp3 .mpa .mpc .mpp .mp+ .msv .nmf .nsf .nsv .oga .ogg .okt .opus .pls .ra .rf64 .rm .s3m .sfx .shn .sid .stm .strm .ult .uni .vox .wav .wma .wv .xm .xsp .ymf'.split(' '));
const cultures = readFileSync(new URL('../core/resources/iso6392.txt', import.meta.url), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => {
  const [term, bibliographic, short, display] = line.split('|');
  return { language: short.includes('-') ? short : term, names: [term, bibliographic, short, display] };
});
const findLanguage = value => cultures.find(culture => culture.names.filter(Boolean).some(name => same(name, value)))?.language;
const replace = (value, token) => value.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), '');

export function parseExternalPath(filename, extra, type, naming = {}) {
  const extension = path.posix.extname(filename).toLowerCase();
  const extensions = type === 'Subtitle' ? naming.SubtitleFileExtensions ?? subtitleExtensions
    : type === 'Lyric' ? naming.LyricFileExtensions ?? lyricExtensions : naming.AudioFileExtensions ?? audioExtensions;
  if (!(type === 'Subtitle' && extension === '.idx') && ![...extensions].some(value => same(value, extension))) return null;
  const info = { Path: filename, IsDefault: false, IsForced: false, IsHearingImpaired: false, Language: null, Title: null };
  if (!extra) return info;
  for (const separator of naming.MediaFlagDelimiters ?? ['.']) {
    let rest = extra, title = '';
    while (rest.length) {
      const index = rest.lastIndexOf(separator); if (index < 0) break;
      const slice = rest.slice(index), token = slice.slice(1), folded = ordinalIgnoreCaseKey(token);
      if ((naming.MediaDefaultFlags ?? ['default']).some(flag => folded.includes(ordinalIgnoreCaseKey(flag)))) { info.IsDefault = true; extra = replace(extra, slice); }
      else if ((naming.MediaForcedFlags ?? ['foreign', 'forced']).some(flag => folded.includes(ordinalIgnoreCaseKey(flag)))) { info.IsForced = true; extra = replace(extra, slice); }
      else {
        const language = findLanguage(token);
        if (language && info.Language == null) { info.Language = language; extra = replace(extra, slice); }
        else if (language && info.Language === 'hin') { info.Language = language; info.IsHearingImpaired = true; extra = replace(extra, slice); }
        else if ((naming.MediaHearingImpairedFlags ?? ['cc', 'hi', 'sdh']).some(flag => same(token, flag))) { info.IsHearingImpaired = true; extra = replace(extra, slice); }
        else title = slice + title;
      }
      rest = rest.slice(0, index);
    }
    info.Title = title.length >= 1 ? title.slice(1) : null;
  }
  return info;
}

export async function externalCandidates(vfs, virtualPath, identityPath, { signal, naming, additionalDirectories = [], types = ['Subtitle', 'Audio'] } = {}) {
  const api = /^[A-Za-z]:[\\/]|^\\\\/u.test(identityPath) ? path.win32 : path.posix;
  const stem = api.basename(identityPath, api.extname(identityPath));
  const directories = [{ virtualPath: path.posix.dirname(virtualPath), identityPath: api.dirname(identityPath) }, ...additionalDirectories];
  const files = [];
  for (const directory of directories) {
    const listing = await vfs.list(directory.virtualPath, { signal });
    for (const entry of listing.entries.filter(entry => entry.kind === 'file')) {
      const accessPath = path.posix.join(directory.virtualPath, entry.name);
      if (accessPath !== virtualPath) files.push({ ...entry, virtualPath: accessPath, identityPath: api.join(directory.identityPath, entry.name) });
    }
  }
  const idx = new Set(files.filter(file => path.posix.extname(file.virtualPath).toLowerCase() === '.idx').map(file => file.virtualPath.slice(0, -4)));
  const sub = new Set(files.filter(file => path.posix.extname(file.virtualPath).toLowerCase() === '.sub').map(file => file.virtualPath.slice(0, -4)));
  const paired = new Set([...idx].filter(key => sub.has(key)));
  const result = [];
  for (const file of files) {
    const extension = path.posix.extname(file.name), name = file.name.slice(0, -extension.length);
    if (!same(name.slice(0, stem.length), stem) || name.length !== stem.length && !(naming?.MediaFlagDelimiters ?? ['.']).includes(name[stem.length])) continue;
    for (const type of types) {
      if (type === 'Subtitle' && (same(extension, '.sub') && paired.has(file.virtualPath.slice(0, -4)) || same(extension, '.idx') && !paired.has(file.virtualPath.slice(0, -4)))) continue;
      const parsed = parseExternalPath(file.identityPath.replaceAll('\\', '/'), name.slice(stem.length), type, naming);
      if (parsed) result.push({ ...file, type, parsed: { ...parsed, Path: file.identityPath },
        relatedPaths: same(extension, '.idx') ? files.filter(entry => entry.virtualPath.slice(0, -4) === file.virtualPath.slice(0, -4) && same(path.posix.extname(entry.name), '.sub')).map(entry => entry.virtualPath) : [] });
    }
  }
  return result;
}

export async function discoverExternalStreams(candidates, { probe, bridge, probeOptions, signal }) {
  const streams = { Audio: [], Subtitle: [] }, failures = [];
  for (const candidate of candidates) {
    if (candidate.virtualPath.toLowerCase().endsWith('.strm')) continue;
    try {
      const result = await probe(bridge, candidate.virtualPath, { ...probeOptions, signal, relatedPaths: candidate.relatedPaths });
      const info = normalizeProbe(result.raw, { path: candidate.identityPath, isAudio: candidate.type === 'Audio' });
      for (const stream of info.MediaStreams.filter(stream => stream.Type === candidate.type)) {
        if (info.MediaStreams.length === 1) Object.assign(stream, { IsDefault: candidate.parsed.IsDefault,
          IsForced: candidate.parsed.IsForced || stream.IsForced, IsHearingImpaired: candidate.parsed.IsHearingImpaired || stream.IsHearingImpaired });
        Object.assign(stream, { Path: candidate.identityPath, IsExternal: true, Title: stream.Title || candidate.parsed.Title || null,
          Language: !stream.Language || same(stream.Language, 'und') ? candidate.parsed.Language || null : stream.Language });
        streams[candidate.type].push(stream);
      }
    } catch (error) { checkAbort(signal); failures.push({ path: candidate.identityPath, code: error.code ?? 'probe-failed' }); }
  }
  return { ...streams, failures };
}
