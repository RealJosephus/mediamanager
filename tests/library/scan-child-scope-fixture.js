// Controlled native lifecycle fixtures use finite arrays instead of SQL.
export function scanChildScope(host) {
  return async (parent, operation) => {
    const captured = [...await host.getChildren(parent)], missing = [];
    return operation({
      async *pages() {
        for (let offset = 0; offset < captured.length; offset += 128) yield captured.slice(offset, offset + 128);
      },
      async markForDeletion(id) { missing.push(id); },
      async deleteMarked() { if (missing.length) await host.deleteCollections(missing); }
    });
  };
}
