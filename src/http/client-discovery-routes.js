import { BinaryResult } from './binary-result.js';

const productName = 'MediaManager';
const index = Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MediaManager</title></head><body><main>MediaManager</main></body></html>');
const strings = Buffer.from(JSON.stringify({ AppName: productName }));
const manifest = Buffer.from(JSON.stringify({ name: productName, short_name: productName,
  lang: 'en-US', display: 'minimal-ui', start_url: 'index.html' }));

export function registerClientDiscoveryRoutes(add) {
  // Hosted clients inspect these product resources during server discovery.
  for (const method of ['GET', 'HEAD']) {
    add(method, '/web/manifest.json', () => BinaryResult.bytes(manifest, 'application/manifest+json; charset=utf-8'), { public: true });
    add(method, '/web/index.html', () => BinaryResult.bytes(index, 'text/html; charset=utf-8'), { public: true });
    add(method, '/web/strings/en-US.json', () => BinaryResult.bytes(strings, 'application/json; charset=utf-8'), { public: true });
  }
}
