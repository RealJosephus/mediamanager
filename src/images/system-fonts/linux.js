import { accessSync, constants } from 'node:fs';
// Fontconfig selection and style conversion follow SkFontMgr_fontconfig.cpp,
// mono/skia@7dbfc07dd33181f84e0958afb7ee805c6c769f0b (BSD-3-Clause).
// https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-devel/
export function resolveLinuxFonts(koffi, probes) {
  const fc = koffi.load('libfontconfig.so.1');
  const addressInfo = koffi.struct({ filename: 'str', base: 'void *', symbol: 'str', address: 'void *' });
  const locate = fc.func('dladdr', 'int', ['void *', koffi.out(koffi.pointer(addressInfo))]);
  const loadedLibrary = {};
  if (!locate(fc.symbol('FcFontMatch'), loadedLibrary) || !loadedLibrary.filename) throw new Error('Could not identify the loaded Fontconfig library.');
  const init = fc.func('void *FcInitLoadConfigAndFonts()');
  const destroyConfig = fc.func('void FcConfigDestroy(void *config)');
  const sysroot = fc.func('const char *FcConfigGetSysRoot(void *config)');
  const configFiles = fc.func('void *FcConfigGetConfigFiles(void *config)');
  const nextFile = fc.func('const char *FcStrListNext(void *list)');
  const doneFiles = fc.func('void FcStrListDone(void *list)');
  const pattern = fc.func('void *FcPatternCreate()');
  const destroyPattern = fc.func('void FcPatternDestroy(void *pattern)');
  const addInteger = fc.func('int FcPatternAddInteger(void *pattern, const char *name, int value)');
  const addString = fc.func('int FcPatternAddString(void *pattern, const char *name, const char *value)');
  const addCharset = fc.func('int FcPatternAddCharSet(void *pattern, const char *name, void *charset)');
  const createCharset = fc.func('void *FcCharSetCreate()');
  const destroyCharset = fc.func('void FcCharSetDestroy(void *charset)');
  const addChar = fc.func('int FcCharSetAddChar(void *charset, uint32_t codepoint)');
  const hasChar = fc.func('int FcCharSetHasChar(void *charset, uint32_t codepoint)');
  const getCharset = fc.func('int FcPatternGetCharSet(void *pattern, const char *name, int index, _Out_ void **charset)');
  const getInteger = fc.func('int FcPatternGetInteger(void *pattern, const char *name, int index, _Out_ int *value)');
  const getString = fc.func('int FcPatternGetString(void *pattern, const char *name, int index, _Out_ const char **value)');
  const valueType = koffi.struct({ type: 'int', value: koffi.union({ string: 'str', number: 'double' }) });
  const addWeak = fc.func('FcPatternAddWeak', 'int', ['void *', 'str', valueType, 'int']);
  const getBinding = fc.func('FcPatternGetWithBinding', 'int', ['void *', 'str', 'int', koffi.out(koffi.pointer(valueType)), koffi.out(koffi.pointer('int'))]);
  const compare = fc.func('int FcStrCmpIgnoreCase(const char *left, const char *right)');
  const substitute = fc.func('int FcConfigSubstitute(void *config, void *pattern, int kind)');
  const defaults = fc.func('void FcDefaultSubstitute(void *pattern)');
  const match = fc.func('void *FcFontMatch(void *config, void *pattern, _Out_ int *result)');
  const config = init();
  if (!config) throw new Error('Could not load the system Fontconfig configuration.');
  const required = (value, operation) => { if (!value) throw new Error(`Fontconfig ${operation} failed.`); return value; };
  function integer(font, name, fallback) { const value = [0]; return getInteger(font, name, 0, value) === 0 ? value[0] : fallback; }
  function string(font, name, index = 0) { const value = [null]; return getString(font, name, index, value) === 0 ? value[0] : null; }
  const weights = [[0, 100], [40, 200], [50, 300], [55, 350], [75, 380], [80, 400], [100, 500], [180, 600], [200, 700], [205, 800], [210, 900], [215, 1000]];
  // FC_WEIGHT_DEMILIGHT is 55 in current Fontconfig; older Skia builds use 65
  // only when the header has no DEMILIGHT constant.
  const widths = [[50, 1], [63, 2], [75, 3], [87, 4], [100, 5], [113, 6], [125, 7], [150, 8], [200, 9]];
  function map(value, ranges) {
    if (value <= ranges[0][0]) return ranges[0][1];
    for (let i = 1; i < ranges.length; i++) if (value < ranges[i][0]) {
      const [x, y] = ranges[i - 1], [end, target] = ranges[i];
      return Math.round(y + (value - x) * (target - y) / (end - x));
    }
    return ranges.at(-1)[1];
  }
  function readable(filename) { try { accessSync(filename, constants.R_OK); return true; } catch { return false; } }
  function familyMatches(font, requested, trimWeak) {
    const values = []; let lastStrong = -1;
    for (let index = 0; ; index++) {
      const value = {}, binding = [0], result = getBinding(requested, 'family', index, value, binding);
      if (result === 3) break;
      if (result !== 0) throw new Error('Could not read Fontconfig family binding.');
      values.push(string(requested, 'family', index));
      if (binding[0] !== 0) lastStrong = index;
    }
    const accepted = trimWeak && lastStrong >= 0 ? values.slice(0, lastStrong + 1) : values;
    for (const name of accepted.slice(0, 16)) for (let index = 0; index < 16; index++) {
      const candidate = string(font, 'family', index);
      if (candidate === null) break;
      if (name !== null && compare(name, candidate) === 0) return true;
    }
    return false;
  }
  function resolve(family, codepoint = null) {
    const request = required(pattern(), 'pattern'); let charset, font;
    try {
      // SKFontManager.MatchCharacter converts null to an empty string before
      // calling Skia. The backend adds that family with weak binding.
      if (codepoint !== null) required(addWeak(request, 'family', { type: 3, value: { string: '' } }, 0), 'weak family');
      else if (family !== null) required(addString(request, 'family', family), 'family');
      for (const [key, value] of [['weight', 200], ['width', 100], ['slant', 0]]) required(addInteger(request, key, value), 'style');
      if (codepoint !== null) {
        charset = required(createCharset(), 'charset'); required(addChar(charset, codepoint), 'probe character');
        required(addCharset(request, 'charset', charset), 'probe charset');
      }
      required(substitute(config, request, 0), 'substitution'); defaults(request);
      const result = [0]; font = match(config, request, result);
      if (!font) return null;
      let filename = string(font, 'file'); if (filename === null) return null;
      const root = sysroot(config);
      if (root && readable(root + filename)) filename = root + filename;
      else if (!readable(filename)) return null;
      if (codepoint !== null) {
        let present = false;
        for (let index = 0; ; index++) {
          const set = [null], result = getCharset(font, 'charset', index, set);
          if (result === 3) break;
          if (result === 0 && hasChar(set[0], codepoint)) { present = true; break; }
        }
        if (!present) return null;
      } else if (!familyMatches(font, request, family !== null)) return null;
      const index = integer(font, 'index', 0), slant = integer(font, 'slant', 0);
      // Higher index bits encode a variable-font named instance. Preserve the
      // selection and fail explicitly until Canvas can consume that instance.
      return { path: filename, collectionIndex: index & 0xffff, namedInstance: index >>> 16,
        family: string(font, 'family'), postscriptName: string(font, 'postscriptname'),
        weight: map(integer(font, 'weight', 80), weights), width: map(integer(font, 'width', 100), widths),
        slant: slant === 100 ? 1 : slant === 110 ? 2 : 0 };
    } finally { if (font) destroyPattern(font); if (charset) destroyCharset(charset); destroyPattern(request); }
  }
  try {
    const configurationFiles = [], list = required(configFiles(config), 'configuration files');
    try { for (let filename; (filename = nextFile(list)) !== null;) configurationFiles.push(filename); }
    finally { doneFiles(list); }
    return { defaultFace: resolve('sans-serif') ?? resolve(null) ?? resolve(null, 0x61),
      probes: probes.map(codepoint => ({ codepoint, face: resolve(null, codepoint) })), configurationFiles,
      libraryFiles: [loadedLibrary.filename] };
  }
  finally { destroyConfig(config); }
}
