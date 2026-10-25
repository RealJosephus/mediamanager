import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fontCollectionFaces } from '../font-collection.js';
import { readCollageFontFace } from '../collage-fonts.js';
import { selectSystemFontDirectory } from './sfnt.js';

export const collageFontProbes = Object.freeze([0x9e21, 0x96de, 0x30ce, 0xac01, 0x1f4a9, 0x5d6, 0x64a]);
let resolution;
const files = new Map(), faces = new Map(), registrations = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const faceKey = face => JSON.stringify([face.path, face.collectionIndex, face.postscriptName ?? null,
  face.weight, face.width, face.slant, face.namedInstance ?? 0, face.simulations ?? 0, face.nameTableSha256 ?? null, face.variations ?? []]);

/** Resolve the actual OS policy once. Importing this module loads no FFI. */
export function resolveCollageSystemFonts() {
  return resolution ??= (async () => {
    const { default: koffi } = await import('koffi');
    let result;
    if (process.platform === 'win32') result = (await import('./win32.js')).resolveWindowsFonts(koffi, collageFontProbes);
    else if (process.platform === 'darwin') result = (await import('./darwin.js')).resolveDarwinFonts(koffi, collageFontProbes);
    else if (process.platform === 'linux') result = (await import('./linux.js')).resolveLinuxFonts(koffi, collageFontProbes);
    else throw new Error(`System collage fonts are unsupported on ${process.platform}.`);
    const selected = [result.defaultFace, ...result.probes.map(row => row.face)], unique = new Map();
    const frozen = face => {
      if (face === null) return null;
      if (!path.isAbsolute(face.path) || !face.family) throw new Error('The system font resolver returned an incomplete font identity.');
      const key = faceKey(face);
      if (!unique.has(key)) unique.set(key, Object.freeze(face));
      return unique.get(key);
    };
    const defaultFace = frozen(result.defaultFace);
    const probes = Object.freeze(result.probes.map(row => Object.freeze({ codepoint: row.codepoint, face: frozen(row.face) })));
    return Object.freeze({ platform: process.platform, defaultFace, probes,
      fallbackFaces: Object.freeze([...probes.flatMap(row => row.face ? [row.face] : []), defaultFace]),
      files: Object.freeze([...new Set(selected.filter(Boolean).map(face => face.path))].sort()),
      configurationFiles: Object.freeze([...(result.configurationFiles ?? [])].sort()),
      libraryFiles: Object.freeze([...(result.libraryFiles ?? [])].sort()),
      ...(result.locale === undefined ? {} : { locale: result.locale }) });
  })();
}

/** Read only a selected face. Duplicate probes share the read and parsed cmap. */
export function loadCollageSystemFace(face) {
  if (!face) return Promise.resolve(null);
  const key = faceKey(face);
  if (!faces.has(key)) faces.set(key, (async () => {
    if (face.namedInstance) throw new Error('Named variable-font instances are not yet supported by the collage renderer.');
    if (!files.has(face.path)) files.set(face.path, readFile(face.path).then(bytes => ({ bytes, sha256: hash(bytes) })));
    const source = await files.get(face.path), directory = selectSystemFontDirectory(source.bytes, face);
    let bytes = source.bytes;
    if (bytes.toString('ascii', 0, 4) === 'ttcf') {
      let index = 0;
      for (const candidate of fontCollectionFaces(bytes)) {
        if (index++ === directory.collectionIndex) { bytes = candidate; break; }
      }
    }
    const metadata = readCollageFontFace(bytes);
    // CoreText's public family/PS aliases are separate from its file's names.
    // That path is bound to the exact OS-returned name table by the selector.
    if (face.nameTableSha256 === undefined && !metadata.families.includes(face.family)) throw new Error('The resolved system family is not present in its selected font file.');
    const tableHashes = Object.fromEntries(['name', 'cmap', 'hmtx', 'maxp'].map(tag => {
      const table = directory.tables.get(tag);
      if (!table) throw new TypeError(`The selected system font has no ${tag} table.`);
      return [tag, hash(table)];
    }));
    return Object.freeze({ ...face, collectionIndex: directory.collectionIndex, bytes, sourceSha256: source.sha256,
      sourceBytes: source.bytes.length, postscriptNames: Object.freeze(directory.postscriptNames), tableHashes: Object.freeze(tableHashes),
      fileStyle: Object.freeze({ weight: metadata.weight, width: metadata.width, slant: metadata.slant }),
      containsGlyphs: metadata.containsGlyphs, glyphForCodepoint: metadata.glyphForCodepoint });
  })());
  return faces.get(key);
}

/** Register only a needed face under an unambiguous private Canvas family. */
export function registerCollageSystemFace(face) {
  if (!face) return Promise.resolve(null);
  const key = faceKey(face);
  if (!registrations.has(key)) registrations.set(key, (async () => {
    const loaded = await loadCollageSystemFace(face), { GlobalFonts } = await import('@napi-rs/canvas');
    const canvasFamily = 'MediaManager Collage ' + hash(key);
    if (!GlobalFonts.register(loaded.bytes, canvasFamily)) throw new Error('Canvas could not register the selected system font face.');
    return Object.freeze({ ...loaded, canvasFamily });
  })());
  return registrations.get(key);
}

/** Draw explicit system glyphs; text shaping and fallback remain the caller's work. */
export async function drawCollageSystemGlyphs(face, options) {
  if (process.platform !== 'darwin') throw new Error('Direct system glyph drawing is available only on macOS.');
  await requireSelectedFace(face);
  const { default: koffi } = await import('koffi');
  return (await import('./darwin.js')).drawDarwinGlyphs(koffi, face, options);
}

export async function measureCollageSystemGlyphs(face, glyphs, size) {
  if (process.platform !== 'darwin') throw new Error('Direct system glyph measurement is available only on macOS.');
  await requireSelectedFace(face);
  const { default: koffi } = await import('koffi');
  return (await import('./darwin.js')).measureDarwinGlyphs(koffi, face, glyphs, size);
}

async function requireSelectedFace(face) {
  const selected = await resolveCollageSystemFonts();
  if (!face || !selected.fallbackFaces.some(candidate => candidate && faceKey(candidate) === faceKey(face))) {
    throw new TypeError('System glyph drawing requires an actually selected collage face.');
  }
}
