export function registerFallbackFontRoutes(add, { fallbackFonts }) {
  if (!fallbackFonts) return;
  add('GET', '/FallbackFont/Fonts', context => fallbackFonts.list({ signal: context.signal }));
  add('GET', '/FallbackFont/Fonts/{name}', context => fallbackFonts.file(context.params.name, { signal: context.signal }));
}
