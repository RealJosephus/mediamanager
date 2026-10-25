// DirectWrite selection follows SkFontMgr_win_dw.cpp in SkiaSharp 3.119.4's
// mono/skia@7dbfc07dd33181f84e0958afb7ee805c6c769f0b (BSD-3-Clause).
// COM slots and GUIDs are from Microsoft's dwrite.h, dwrite_1.h, dwrite_2.h:
// https://github.com/microsoft/win32metadata/tree/main/generation/WinSDK/RecompiledIdlHeaders/um
const failure = -2147467259, noInterface = -2147467262;
function guid(value) {
  const [a, b, c, d, e] = value.split('-'), bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(a, 16)); bytes.writeUInt16LE(parseInt(b, 16), 4); bytes.writeUInt16LE(parseInt(c, 16), 6);
  Buffer.from(d + e, 'hex').copy(bytes, 8); return bytes;
}
const ids = {
  factory: guid('0439fc60-ca44-4994-8dee-3a9af7b732ec'),
  loader: guid('b2d9f3ec-c9fe-4a11-a2ec-d86208f7c0a2'),
  unknown: guid('00000000-0000-0000-c000-000000000046'),
  source: guid('688e1a58-5094-47c8-adc8-fbcea60ae92b')
};

export function resolveWindowsFonts(koffi, probes) {
  const library = koffi.load('dwrite.dll'), kernel = koffi.load('kernel32.dll');
  const createFactory = library.func('int32_t __stdcall DWriteCreateFactory(int type, const void *iid, _Out_ void **factory)');
  const getLocale = kernel.func('int __stdcall GetUserDefaultLocaleName(_Out_ uint16_t *buffer, int length)');
  const moduleAt = kernel.func('int __stdcall GetModuleHandleExW(uint32_t flags, const void *address, _Out_ void **module)');
  const moduleNamed = kernel.func('void *__stdcall GetModuleHandleW(str16 name)');
  const modulePath = kernel.func('uint32_t __stdcall GetModuleFileNameW(void *module, _Out_ uint16_t *path, uint32_t size)');
  const libraryFiles = [];
  for (const module of [moduleNamed('kernel32.dll'), ...[library.symbol('DWriteCreateFactory'), kernel.symbol('GetUserDefaultLocaleName')].map(address => {
    const out = [null];
    if (!moduleAt(6, address, out)) throw new Error('Could not identify a loaded Windows font-query module.');
    return out[0];
  })]) {
    if (!module) throw new Error('A required Windows font-query module is absent.');
    const bytes = Buffer.alloc(32768 * 2), length = modulePath(module, bytes, 32768);
    if (!length || length >= 32768) throw new Error('Could not read a loaded Windows font-query module path.');
    libraryFiles.push(bytes.toString('utf16le', 0, length * 2));
  }
  const pointerSize = koffi.sizeof('void *'), prototypes = new Map();
  function method(object, slot, returns, parameters, ...args) {
    if (!object) throw new Error('A required DirectWrite interface is null.');
    const signature = `${returns}(${parameters.join(',')})`;
    if (!prototypes.has(signature)) {
      const types = parameters.map(type => type.startsWith('_Out_ ') ? koffi.out(type.slice(6))
        : type.startsWith('_Inout_ ') ? koffi.inout(type.slice(8)) : type);
      prototypes.set(signature, koffi.proto('__stdcall', `MM_DWrite_${prototypes.size}`, returns, ['void *', ...types]));
    }
    const vtable = koffi.decode(object, 'void *'), address = koffi.decode(vtable, slot * pointerSize, 'void *');
    return koffi.call(address, prototypes.get(signature), object, ...args);
  }
  const check = (result, operation) => { if (result < 0) throw new Error(`DirectWrite ${operation} failed: 0x${(result >>> 0).toString(16)}.`); };
  const release = object => { if (object) method(object, 2, 'uint32_t', []); };
  const acquire = (object, slot, operation, parameters = [], args = []) => {
    const result = [null]; check(method(object, slot, 'int32_t', [...parameters, '_Out_ void **'], ...args, result), operation);
    if (!result[0]) throw new Error(`DirectWrite ${operation} returned no interface.`);
    return result[0];
  };
  function localized(strings) {
    const index = [0], exists = [0];
    check(method(strings, 4, 'int32_t', ['str16', '_Out_ uint32_t *', '_Out_ int32_t *'], 'en-us', index, exists), 'FindLocaleName');
    if (!exists[0]) index[0] = 0;
    const length = [0]; check(method(strings, 7, 'int32_t', ['uint32_t', '_Out_ uint32_t *'], index[0], length), 'GetStringLength');
    const bytes = Buffer.alloc((length[0] + 1) * 2);
    check(method(strings, 8, 'int32_t', ['uint32_t', '_Out_ uint16_t *', 'uint32_t'], index[0], bytes, length[0] + 1), 'GetString');
    return bytes.toString('utf16le', 0, length[0] * 2);
  }
  function identity(font) {
    if (!font) return null;
    const owned = [], own = value => { owned.push(value); return value; };
    try {
      const face = own(acquire(font, 13, 'CreateFontFace')), family = own(acquire(font, 3, 'GetFontFamily'));
      const names = own(acquire(family, 6, 'GetFamilyNames'));
      const count = [0]; check(method(face, 4, 'int32_t', ['_Inout_ uint32_t *', 'void *'], count, null), 'GetFiles count');
      if (count[0] !== 1) throw new Error('The selected DirectWrite font must have one OpenType file.');
      const files = [null]; check(method(face, 4, 'int32_t', ['_Inout_ uint32_t *', '_Out_ void **'], count, files), 'GetFiles');
      const file = own(files[0]), key = [null], keySize = [0];
      check(method(file, 3, 'int32_t', ['_Out_ void **', '_Out_ uint32_t *'], key, keySize), 'GetReferenceKey');
      const loader = own(acquire(file, 4, 'GetLoader'));
      const localLoader = own(acquire(loader, 0, 'QueryInterface LocalFontFileLoader', ['const void *'], [ids.loader]));
      const length = [0]; check(method(localLoader, 4, 'int32_t', ['const void *', 'uint32_t', '_Out_ uint32_t *'], key[0], keySize[0], length), 'GetFilePathLengthFromKey');
      const bytes = Buffer.alloc((length[0] + 1) * 2);
      check(method(localLoader, 5, 'int32_t', ['const void *', 'uint32_t', '_Out_ uint16_t *', 'uint32_t'], key[0], keySize[0], bytes, length[0] + 1), 'GetFilePathFromKey');
      const dwSlant = method(font, 6, 'int', []);
      return { path: bytes.toString('utf16le', 0, length[0] * 2), collectionIndex: method(face, 5, 'uint32_t', []),
        family: localized(names), weight: method(font, 4, 'int', []), width: method(font, 5, 'int', []),
        slant: dwSlant === 2 ? 1 : dwSlant === 1 ? 2 : 0, simulations: method(font, 10, 'int', []) };
    } finally { for (const object of owned.reverse()) release(object); }
  }
  const factoryOut = [null]; check(createFactory(0, ids.factory, factoryOut), 'DWriteCreateFactory');
  const factory = factoryOut[0]; let collection, fallback, substitution;
  try {
    const out = [null]; check(method(factory, 3, 'int32_t', ['_Out_ void **', 'int32_t'], out, 0), 'GetSystemFontCollection'); collection = out[0];
    fallback = acquire(factory, 26, 'GetSystemFontFallback');
    const localeBytes = Buffer.alloc(85 * 2), localeLength = getLocale(localeBytes, 85);
    const locale = localeLength > 0 ? localeBytes.toString('utf16le', 0, (localeLength - 1) * 2) : '';
    substitution = acquire(factory, 22, 'CreateNumberSubstitution', ['int', 'str16', 'int32_t'], [2, locale, 1]);
    // SkiaSharp SKFontManager.MatchCharacter changes null to string.Empty
    // before the C API; Skia forwards that empty family to DirectWrite.
    function match(codepoint, baseFamily = '') {
      // MapCharacters is synchronous. All callback pointers and pointed-to
      // strings stay allocated until it returns and all retained references
      // have been released. JS exceptions are captured, never unwound over COM.
      const allocations = [], callbacks = [];
      const allocate = (type, count = 1) => { const pointer = koffi.alloc(type, count); allocations.push(pointer); return pointer; };
      const encode = (pointer, type, value) => koffi.encode(pointer, type, value);
      const persistentString = value => {
        const bytes = Buffer.from(value + '\0', 'utf16le'), pointer = allocate('uint8_t', bytes.length);
        koffi.encode(pointer, 'uint8_t', [...bytes], bytes.length); return pointer;
      };
      let error, references = 1, font;
      try {
        const text = String.fromCodePoint(codepoint), textPointer = persistentString(text), localePointer = persistentString(locale);
        const object = allocate('void *'), vtable = allocate('void *', 8);
        const register = (slot, returns, parameters, implementation) => {
          const proto = koffi.proto('__stdcall', `MM_Source_${codepoint}_${slot}_${baseFamily === null ? 0 : 1}`, returns, ['void *', ...parameters]);
          const callback = koffi.register((...args) => {
            try { return implementation(...args); }
            catch (cause) { error ??= cause; return returns === 'int32_t' ? failure : 0; }
          }, koffi.pointer(proto));
          callbacks.push(callback); koffi.encode(vtable, slot * pointerSize, 'void *', callback);
        };
        register(0, 'int32_t', ['void *', 'void *'], (_self, iid, output) => {
          const requested = Buffer.from(koffi.decode(iid, 'uint8_t', 16));
          if (!requested.equals(ids.unknown) && !requested.equals(ids.source)) { encode(output, 'void *', null); return noInterface; }
          encode(output, 'void *', object); references++; return 0;
        });
        register(1, 'uint32_t', [], () => ++references);
        register(2, 'uint32_t', [], () => --references);
        register(3, 'int32_t', ['uint32_t', 'void *', 'void *'], (_self, position, string, length) => {
          encode(string, 'void *', position < text.length ? textPointer + BigInt(position * 2) : null);
          encode(length, 'uint32_t', Math.max(0, text.length - position)); return 0;
        });
        register(4, 'int32_t', ['uint32_t', 'void *', 'void *'], (_self, position, string, length) => {
          const present = position > 0 && position < text.length;
          encode(string, 'void *', present ? textPointer : null); encode(length, 'uint32_t', present ? position : 0); return 0;
        });
        register(5, 'int', [], () => 0);
        register(6, 'int32_t', ['uint32_t', 'void *', 'void *'], (_self, position, length, output) => {
          encode(length, 'uint32_t', Math.max(0, text.length - position)); encode(output, 'void *', localePointer); return 0;
        });
        register(7, 'int32_t', ['uint32_t', 'void *', 'void *'], (_self, position, length, output) => {
          encode(length, 'uint32_t', Math.max(0, text.length - position));
          method(substitution, 1, 'uint32_t', []); encode(output, 'void *', substitution); return 0;
        });
        encode(object, 'void *', vtable);
        const mapped = [0], selected = [null], scale = [0];
        const result = method(fallback, 3, 'int32_t', ['void *', 'uint32_t', 'uint32_t', 'void *', 'str16', 'int', 'int', 'int', '_Out_ uint32_t *', '_Out_ void **', '_Out_ float *'],
          object, 0, text.length, collection, baseFamily, 700, 0, 5, mapped, selected, scale);
        font = selected[0];
        if (error) throw error;
        check(result, 'MapCharacters');
        if (references !== 1) throw new Error('DirectWrite retained the synchronous font analysis source.');
        if (font && mapped[0] !== text.length) throw new Error('DirectWrite did not map the complete font probe.');
        return identity(font);
      } finally {
        release(font);
        for (const callback of callbacks.reverse()) koffi.unregister(callback);
        for (const pointer of allocations.reverse()) koffi.free(pointer);
      }
    }
    const index = [0], exists = [0];
    check(method(collection, 5, 'int32_t', ['str16', '_Out_ uint32_t *', '_Out_ int32_t *'], 'sans-serif', index, exists), 'FindFamilyName');
    let defaultFace;
    if (exists[0]) {
      let family, font;
      try {
        family = acquire(collection, 4, 'GetFontFamily', ['uint32_t'], [index[0]]);
        font = acquire(family, 7, 'GetFirstMatchingFont', ['int', 'int', 'int'], [700, 5, 0]);
        defaultFace = identity(font);
      } finally { release(font); release(family); }
    } else defaultFace = match(32, 'sans-serif');
    defaultFace ??= match(0x61);
    return { defaultFace, probes: probes.map(codepoint => ({ codepoint, face: match(codepoint) })), locale,
      libraryFiles: [...new Set(libraryFiles)] };
  } finally { release(substitution); release(fallback); release(collection); release(factory); }
}
