import { subtitleSamiBoundaryInput } from './input.js';

/** Explicit UTF-8 identity; the original unmarked sources remain unchanged. */
export function subtitleSamiUtf8BoundaryInput() {
  const input = subtitleSamiBoundaryInput();
  const identify = name => `utf8-bom-${name}`;
  return { ...input,
    sources: input.sources.map(source => ({ ...source, name: identify(source.name), text: '\uFEFF' + source.text })),
    conversions: input.conversions.map(conversion => ({ ...conversion,
      name: identify(conversion.name), source: identify(conversion.source) })),
  };
}
