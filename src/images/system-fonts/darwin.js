// CoreText calls follow SkiaSharp 3.119.4's Skia backend (BSD-3-Clause):
// mono/skia@7dbfc07dd33181f84e0958afb7ee805c6c769f0b, SkFontMgr_mac_ct.cpp
// and SkTypeface_mac_ct.cpp. The family alias below is that backend's CSS
// mapping; fallback families are always selected by CoreText, never a list.
import { createHash } from 'node:crypto';

let api;
export function resolveDarwinFonts(koffi, probes) { return (api ??= darwinFontApi(koffi)).resolve(probes); }
export function drawDarwinGlyphs(koffi, face, options) { return (api ??= darwinFontApi(koffi)).draw(face, options); }

function darwinFontApi(koffi) {
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const ct = koffi.load('/System/Library/Frameworks/CoreText.framework/CoreText');
  const kit = koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const release = cf.func('void CFRelease(void *value)');
  const dictionary = cf.func('void *CFDictionaryCreateMutable(void *allocator, long capacity, void *keys, void *values)');
  const dictionaryKeys = cf.symbol('kCFTypeDictionaryKeyCallBacks'), dictionaryValues = cf.symbol('kCFTypeDictionaryValueCallBacks');
  const set = cf.func('void CFDictionarySetValue(void *dictionary, void *key, void *value)');
  const get = cf.func('void *CFDictionaryGetValue(void *dictionary, void *key)');
  const dictionaryCount = cf.func('long CFDictionaryGetCount(void *dictionary)');
  const dictionaryEntries = cf.func('void CFDictionaryGetKeysAndValues(void *dictionary, void *keys, void *values)');
  const createNumber = cf.func('void *CFNumberCreate(void *allocator, int type, const double *value)');
  const createInteger = cf.func('CFNumberCreate', 'void *', ['void *', 'int', 'const int32_t *']);
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
  const copyVariation = ct.func('void *CTFontCopyVariation(void *font)');
  const copySized = ct.func('void *CTFontCreateCopyWithAttributes(void *font, double size, void *matrix, void *attributes)');
  const range = koffi.struct({ location: 'long', length: 'long' });
  const forString = ct.func('CTFontCreateForString', 'void *', ['void *', 'void *', range]);
  const key = name => koffi.decode(ct.symbol(name), 'void *');
  const keys = Object.fromEntries(['TraitsAttribute', 'FamilyNameAttribute', 'NameAttribute', 'VariationAttribute', 'WeightTrait', 'WidthTrait', 'SlantTrait', 'URLAttribute']
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
  function variations(font) {
    const values = copyVariation(font);
    if (!values) return [];
    try {
      const count = Number(dictionaryCount(values));
      if (!count) return [];
      const keyBuffer = Buffer.alloc(count * 8), valueBuffer = Buffer.alloc(count * 8);
      dictionaryEntries(values, keyBuffer, valueBuffer);
      const axes = koffi.decode(keyBuffer, 'void *', count), coordinates = koffi.decode(valueBuffer, 'void *', count);
      return Array.from({ length: count }, (_, index) => {
        const axis = [0], value = [0];
        if (type(axes[index]) !== numberType() || type(coordinates[index]) !== numberType()
          || !readNumber(axes[index], 13, axis) || !readNumber(coordinates[index], 13, value)
          || !Number.isInteger(axis[0]) || !Number.isFinite(value[0])) throw new Error('Invalid CoreText font variation.');
        return Object.freeze({ axis: axis[0] >>> 0, value: value[0] });
      }).sort((left, right) => left.axis - right.axis);
    } finally { release(values); }
  }
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
        variations: Object.freeze(variations(font)),
        weight: weight(number('WeightTrait')), width: Math.max(1, Math.min(9, Math.round((number('WidthTrait') + 0.5) * 10))),
        slant: number('SlantTrait') ? 1 : 0 };
    } finally { if (names) release(names); if (url) release(url); release(traits); }
  }
  function resolve(probes) {
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

  // A selected system face may use an outline format that a file-only font
  // backend cannot decode. Draw explicit glyphs through the public OS API;
  // this neither selects fallback fonts nor performs text shaping.
  let graphics;
  function draw(face, { glyphs, positions, size, width, height }) {
    if (!Array.isArray(glyphs) || !Array.isArray(positions) || glyphs.length !== positions.length
      || glyphs.some(glyph => !Number.isInteger(glyph) || glyph < 0 || glyph > 65535)
      || positions.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))
      || !Number.isFinite(size) || size <= 0 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height * 4)) throw new TypeError('Invalid system glyph drawing input.');
    const owned = [], own = value => { owned.push(required(value, 'glyph drawing')); return value; };
    try {
      const attributes = own(dictionary(null, 0, dictionaryKeys, dictionaryValues));
      set(attributes, keys.NameAttribute, own(createString(null, face.postscriptName, utf8)));
      const variation = own(dictionary(null, 0, dictionaryKeys, dictionaryValues));
      for (const coordinate of face.variations) {
        set(variation, own(createInteger(null, 3, [coordinate.axis | 0])), own(createNumber(null, 13, [coordinate.value])));
      }
      set(attributes, keys.VariationAttribute, variation);
      const base = own(createFont(own(createDescriptor(attributes)), 0, null));
      const observed = identity(base);
      for (const name of ['path', 'family', 'postscriptName', 'nameTableSha256', 'weight', 'width', 'slant', 'variations']) {
        if (JSON.stringify(observed[name]) !== JSON.stringify(face[name])) throw new Error(`The system drawing face changed its ${name}: ${JSON.stringify(face[name])} -> ${JSON.stringify(observed[name])}.`);
      }
      const font = own(copySized(base, size, null, null));
      const drawnFace = identity(font);
      for (const name of ['path', 'family', 'postscriptName', 'nameTableSha256', 'weight', 'width', 'slant', 'variations']) {
        if (JSON.stringify(drawnFace[name]) !== JSON.stringify(face[name])) throw new Error(`The sized system drawing face changed its ${name}: ${JSON.stringify(face[name])} -> ${JSON.stringify(drawnFace[name])}.`);
      }
      graphics ??= drawingApi();
      return { ...graphics.draw(font, { glyphs, positions, size, width, height }), identity: drawnFace };
    } finally { for (const value of owned.reverse()) release(value); }
  }
  function drawingApi() {
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const colorSpace = cg.func('void *CGColorSpaceCreateDeviceRGB()');
    const releaseColorSpace = cg.func('void CGColorSpaceRelease(void *space)');
    const bitmap = cg.func('void *CGBitmapContextCreate(void *data, size_t width, size_t height, size_t depth, size_t rowBytes, void *space, uint32_t flags)');
    const releaseContext = cg.func('void CGContextRelease(void *context)');
    const fill = cg.func('void CGContextSetRGBFillColor(void *context, double red, double green, double blue, double alpha)');
    const flush = cg.func('void CGContextFlush(void *context)');
    const settings = [
      // Skia's normal-hinted outline path allows CoreGraphics smoothing
      // (outline dilation). Disabling it draws visibly thinner title strokes.
      ['CGContextSetShouldAntialias', true], ['CGContextSetShouldSmoothFonts', true],
      ['CGContextSetAllowsFontSubpixelPositioning', true], ['CGContextSetShouldSubpixelPositionFonts', true],
      ['CGContextSetAllowsFontSubpixelQuantization', false], ['CGContextSetShouldSubpixelQuantizeFonts', false]
    ].map(([name, value]) => [cg.func(name, 'void', ['void *', 'bool']), value]);
    // CGPoint and CGSize both contain two CGFloat (double) fields on macOS.
    const measure = ct.func('double CTFontGetAdvancesForGlyphs(void *font, uint32_t orientation, const uint16_t *glyphs, void *advances, long count)');
    const drawGlyphs = ct.func('void CTFontDrawGlyphs(void *font, const uint16_t *glyphs, const void *positions, size_t count, void *context)');
    return { draw(font, { glyphs, positions, size, width, height }) {
      const pixels = Buffer.alloc(width * height * 4), points = Buffer.alloc(positions.length * 16), widths = Buffer.alloc(glyphs.length * 16);
      positions.forEach((point, index) => { points.writeDoubleLE(point.x, index * 16); points.writeDoubleLE(height - point.y, index * 16 + 8); });
      const ids = Uint16Array.from(glyphs), space = required(colorSpace(), 'color space');
      let context;
      try {
        // Big-endian RGBA with premultiplied alpha, independent of CPU order.
        context = required(bitmap(pixels, width, height, 8, width * 4, space, 0x4001), 'bitmap context');
        for (const [setting, value] of settings) setting(context, value);
        fill(context, 1, 1, 1, 1);
        if (glyphs.length) { measure(font, 1, ids, widths, glyphs.length); drawGlyphs(font, ids, points, glyphs.length, context); }
        flush(context);
        return { width, height, size, format: 'rgba-premultiplied', pixels,
          advances: glyphs.map((_, index) => ({ x: widths.readDoubleLE(index * 16), y: -widths.readDoubleLE(index * 16 + 8) })) };
      } finally { if (context) releaseContext(context); releaseColorSpace(space); }
    } };
  }
  return { resolve, draw };
}
