import { MIMEType } from 'node:util';

export function jsonProfile(accept) {
  let selected, selectedQuality = -1;
  // BaseJellyfinApiController offers plain JSON, CamelCase and PascalCase.
  // MVC chooses a matching offer by quality and then request order; a later
  // profile in the SDK's Accept list must not change an earlier plain offer.
  for (const range of accept.match(/(?:[^,"]|"(?:\\.|[^"\\])*")+/gu) ?? []) {
    let mediaType;
    try { mediaType = new MIMEType(range); }
    catch { continue; }
    if (!['application/json', 'application/*', '*/*'].includes(mediaType.essence)) continue;
    const weight = mediaType.params.get('q') ?? '1';
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(weight)) continue;
    const quality = Number(weight);
    if (!Number.isFinite(quality) || quality <= selectedQuality) continue;
    let profile, supported = true;
    for (const [name, value] of mediaType.params) {
      // Parameters after q describe the Accept offer, not the output format.
      if (name === 'q') break;
      if (name === 'profile' && /^(?:CamelCase|PascalCase)$/iu.test(value)) {
        profile = /^CamelCase$/iu.test(value) ? 'CamelCase' : 'PascalCase';
      } else if (name !== '*') supported = false;
    }
    if (supported) { selected = profile; selectedQuality = quality; }
  }
  // Native MVC falls back to its default plain JSON formatter when no offer
  // matches; the application does not enable ReturnHttpNotAcceptable.
  return selected;
}
