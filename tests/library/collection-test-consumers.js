import { publishNativeItemLinks } from '../../src/library/native-item-entity.js';
import { EMPTY_NATIVE_LINKS } from '../../src/library/postgres-linked-children.js';
import { idKey } from '../../src/library/records.js';

/** Finite fixture projection; production consumers retain only one page. */
export async function readTestLinks(item) {
  if (item.LinkedChildren === null) return null;
  if (item.LinkedChildren === EMPTY_NATIVE_LINKS) return [];
  const result = [];
  for await (const page of item.LinkedChildren.pages()) result.push(...page);
  return result;
}
export async function readTestLinkIds(item) {
  return (await readTestLinks(item)).map(link => idKey(link.ItemId));
}
export async function assignTestLinks(runtime, item, links) {
  if (links === null) { item.LinkedChildren = null; return; }
  await runtime.linkedChildren.withSession(async session => {
    const writer = await runtime.linkedChildren.createWriter({ session, parentId: item.Id });
    try {
      for (const link of links) await writer.append(link);
      publishNativeItemLinks(item, await writer.finish());
    } catch (error) { await writer.abort(); throw error; }
    await runtime.linkedChildren.flushReleases({ session });
  });
}
export function captureTestEvent(items) {
  const retained = items.retain();
  return (async () => {
    const result = [];
    try {
      for await (const page of retained.pages()) result.push(...page.entries.map(row => idKey(row.Item.Id)));
      return result;
    } finally { await retained.release(); }
  })();
}
