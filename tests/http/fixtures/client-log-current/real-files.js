import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

/** Observe actual instance log handles; all opening, writing and closing use fs. */
export function observeLogFiles(directory) {
  const original = fs.open, opened = [], gates = new Set();
  let nextGate;
  fs.open = async (...argumentsList) => {
    const handle = await original(...argumentsList), filename = path.resolve(String(argumentsList[0]));
    if (path.dirname(filename) !== directory || !path.basename(filename).startsWith('upload_')) return handle;
    const gate = nextGate; nextGate = undefined;
    const close = handle.close.bind(handle), observation = { filename, handle, closed: false, closing: false };
    opened.push(observation);
    handle.close = async () => {
      observation.closing = true;
      if (gate) { gate.entered.resolve(observation); await gate.release.promise; }
      await close(); observation.closed = true;
    };
    return handle;
  };
  syncBuiltinESMExports();
  return {
    opened,
    holdNextClose() {
      assert.equal(nextGate, undefined);
      const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }; gates.add(gate); nextGate = gate;
      return { entered: gate.entered.promise, release: () => gate.release.resolve() };
    },
    restore() {
      for (const gate of gates) gate.release.resolve();
      fs.open = original; syncBuiltinESMExports();
    },
  };
}
