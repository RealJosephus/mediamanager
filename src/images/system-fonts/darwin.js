// CoreText calls follow SkiaSharp 3.119.4's Skia backend (BSD-3-Clause):
// mono/skia@7dbfc07dd33181f84e0958afb7ee805c6c769f0b, SkFontMgr_mac_ct.cpp
// and SkTypeface_mac_ct.cpp. The family alias below is that backend's CSS
// mapping; fallback families are always selected by CoreText, never a list.
import { createHash } from 'node:crypto';

export function resolveDarwinFonts(koffi, probes) {
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const ct = koffi.load('/System/Library/Frameworks/CoreText.framework/CoreText');
  const kit = koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const release = cf.func('void CFRelease(void *value)');
  const dictionary = cf.func('void *CFDictionaryCreateMutable(void *allocator, long capacity, void *keys, void *values)');
  const dictionaryKeys = cf.symbol('kCFTypeDictionaryKeyCallBacks'), dictionaryValues = cf.symbol('kCFTypeDictionaryValueCallBacks');
  const set = cf.func('void CFDictionarySetValue(void *dictionary, void *key, void *value)');
  const get = cf.func('void *CFDictionaryGetValue(void *dictionary, void *key)');
  const createNumber = cf.func('void *CFNumberCreate(void *allocator, int type, const double *value)');
  const readNumber = cf.func('bool CFNumberGetValue(void *number, int type, _Out_ double *value)');
  const floatNumber = cf.func('bool CFNumberIsFloatType(void *number)');
  const numberType = cf.func('ulong CFNumberGetTypeID()');
  const type = cf.func('ulong CFGetTypeID(void *value)');
  const dataLength = cf.func('long CFDataGetLength(void *data)');
  const dataBytes = cf.func('const uint8_t *CFDataGetBytePtr(void *data)');
  const createString = cf.func('void *CFStringCreateWithCString(void *allocator, const char *value, uint32_t encoding)');
  const stringLength = cf.func('long CFStringGetLength(void *value)');
  const getString = cf.func('bool CFStringGetCString(void *value, _Out_ char *buffer, long size, uint32_t encoding)');
  const urlPath = cf.func('void *CFURLCopyFileSystemPath(void *url, int style)');
  const createDescriptor = ct.func('void *CTFontDescriptorCreateWithAttributes(void *attributes)');
  const createFont = ct.func('void *CTFontCreateWithFontDescriptor(void *descriptor, double size, void *matrix)');
  const copyTraits = ct.func('void *CTFontCopyTraits(void *font)');
  const symbolic = ct.func('uint32_t CTFontGetSymbolicTraits(void *font)');
  const copySymbolic = ct.func('void *CTFontCreateCopyWithSymbolicTraits(void *font, double size, void *matrix, uint32_t value, uint32_t mask)');
  const copyFamily = ct.func('void *CTFontCopyFamilyName(void *font)');
  const copyPostscript = ct.func('void *CTFontCopyPostScriptName(void *font)');
  const copyAttribute = ct.func('void *CTFontCopyAttribute(void *font, void *attribute)');
  const copyTable = ct.func('void *CTFontCopyTable(void *font, uint32_t tag, uint32_t options)');
  const range = koffi.struct({ location: 'long', length: 'long' });
  const forString = ct.func('CTFontCreateForString', 'void *', ['void *', 'void *', range]);
  const key = name => koffi.decode(ct.symbol(name), 'void *');
  const keys = Object.fromEntries(['TraitsAttribute', 'FamilyNameAttribute', 'WeightTrait', 'WidthTrait', 'SlantTrait', 'URLAttribute']
    .map(name => [name, key('kCTFont' + name)]));
  const weights = [-1, ...['UltraLight', 'Thin', 'Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'Heavy', 'Black']
    .map(name => koffi.decode(kit.symbol('NSFontWeight' + name), 'double')), 1];
  const utf8 = 0x08000100;
  const required = (value, operation) => { if (!value) throw new Error(`CoreText ${operation} failed.`); return value; };
  function text(value) {
    required(value, 'string');
    const bytes = Buffer.alloc(Number(stringLength(value)) * 4 + 1);
    if (!getString(value, bytes, bytes.length, utf8)) throw new Error('Could not decode a CoreText font name.');
    return bytes.toString('utf8', 0, bytes.indexOf(0));
  }
  function ownedText(value) { try { return text(value); } finally { if (value) release(value); } }
  function makeFont(family, bold = true) {
    const owned = [], own = value => { owned.push(required(value, 'descriptor')); return value; };
    try {
      // Standard CF callbacks retain values for any descriptor/font that keeps
      // a dictionary. The local Create references are independently released.
      const attributes = own(dictionary(null, 0, dictionaryKeys, dictionaryValues)), traits = own(dictionary(null, 0, dictionaryKeys, dictionaryValues));
      for (const [name, value] of [['WeightTrait', weights[bold ? 7 : 4]], ['WidthTrait', 0], ['SlantTrait', 0]]) {
        set(traits, keys[name], own(createNumber(null, 13, [value]))); // kCFNumberDoubleType
      }
      set(attributes, keys.TraitsAttribute, traits);
      if (family !== null) set(attributes, keys.FamilyNameAttribute, own(createString(null, family, utf8)));
      return createFont(own(createDescriptor(attributes)), 0, null);
    } finally { for (const value of owned.reverse()) release(value); }
  }
  function weight(value) {
    if (value <= weights[0]) return 0;
    for (let i = 0; i < weights.length - 1; i++) {
      if (value < weights[i + 1]) return Math.round(i * 100 + (value - weights[i]) * 100 / (weights[i + 1] - weights[i]));
    }
    return 1000;
  }
  function identity(font) {
    if (!font) return null;
    const traits = required(copyTraits(font), 'traits');
    let url, names;
    try {
      const number = name => {
        const value = get(traits, keys[name]), out = [0];
        return value && type(value) === numberType() && floatNumber(value) && readNumber(value, 13, out) ? out[0] : 0;
      };
      url = required(copyAttribute(font, keys.URLAttribute), 'font file URL');
      // CoreText can expose a public alias for a reserved system face. Bind
      // its actual name table instead of guessing how that alias is spelled
      // inside the TTC. Skia's table reader uses this same public API.
      names = required(copyTable(font, 0x6e616d65, 0), 'name table');
      const length = Number(dataLength(names));
      if (!Number.isSafeInteger(length) || length < 6) throw new Error('CoreText returned an invalid name table.');
      const nameTable = Buffer.from(koffi.decode(required(dataBytes(names), 'name table bytes'), 'uint8_t', length));
      return { path: ownedText(urlPath(url, 0)), collectionIndex: null,
        family: ownedText(copyFamily(font)), postscriptName: ownedText(copyPostscript(font)),
        nameTableSha256: createHash('sha256').update(nameTable).digest('hex'),
        weight: weight(number('WeightTrait')), width: Math.max(1, Math.min(9, Math.round((number('WidthTrait') + 0.5) * 10))),
        slant: number('SlantTrait') ? 1 : 0 };
    } finally { if (names) release(names); if (url) release(url); release(traits); }
  }
  let regularDefault, defaultFont, familyFont;
  try {
    regularDefault = makeFont('Helvetica');
    defaultFont = regularDefault;
    // Skia's default-family path corrects a missing requested bold trait;
    // its MatchCharacter path deliberately does not apply this correction.
    if (defaultFont && !(symbolic(defaultFont) & 2)) defaultFont = copySymbolic(defaultFont, 0, null, symbolic(defaultFont) | 2, symbolic(defaultFont) | 2) || defaultFont;
    if (!defaultFont) defaultFont = makeFont('Lucida Sans', false);
    // SKFontManager's managed null-family workaround passes an empty family.
    familyFont = required(makeFont(''), 'fallback base font');
    const match = codepoint => {
      let string, font;
      try {
        string = required(createString(null, String.fromCodePoint(codepoint), utf8), 'probe string');
        font = forString(familyFont, string, { location: 0, length: Number(stringLength(string)) });
        return identity(font);
      } finally { if (font) release(font); if (string) release(string); }
    };
    const defaultFace = identity(defaultFont) ?? match(0x61);
    const selected = probes.map(codepoint => ({ codepoint, face: match(codepoint) }));
    return { defaultFace, probes: selected };
  } finally {
    if (familyFont) release(familyFont);
    if (defaultFont && defaultFont !== regularDefault) release(defaultFont);
    if (regularDefault) release(regularDefault);
    // Keep framework handles resident: CoreText and AppKit maintain process
    // state, but every Create/Copy object owned above has been released.
  }
}
