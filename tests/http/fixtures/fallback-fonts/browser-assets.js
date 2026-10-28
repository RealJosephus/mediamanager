import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['subtitles-octopus.js', 'subtitles-octopus-worker.js', 'subtitles-octopus-worker-legacy.js',
  'subtitles-octopus-worker.wasm', 'default.woff2'];

/** Read the same-run npm cache, whose complete tree the Web input receipt binds. */
export async function libassAssets(web, output) {
  const lock = JSON.parse(await readFile(path.join(web.root, 'source/package-lock.json'), 'utf8'));
  const dependency = lock.packages['node_modules/@jellyfin/libass-wasm'];
  if (dependency.version !== '4.2.4' || dependency.resolved !== 'https://registry.npmjs.org/@jellyfin/libass-wasm/-/libass-wasm-4.2.4.tgz'
    || dependency.integrity !== 'sha512-xgOxp0Lmg7djdRpC+RRFaN28QeoMr46tOgL9/xbXqM46RjjVruFC3iK7K8AuGNUZ11Ysil23p0kACQw06GuaRw==') {
    throw new Error('The designated Web font consumer dependency changed.');
  }
  const integrity = Buffer.from(dependency.integrity.slice('sha512-'.length), 'base64').toString('hex');
  const archive = path.join(web.root, 'npm-cache/_cacache/content-v2/sha512', integrity.slice(0, 2), integrity.slice(2, 4), integrity.slice(4));
  const compressed = await readFile(archive);
  if ('sha512-' + createHash('sha512').update(compressed).digest('base64') !== dependency.integrity) throw new Error('The actual libass package differs from the Web lock.');
  const tar = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }), members = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/su, '');
    const prefix = text(345, 500), name = (prefix ? prefix + '/' : '') + text(0, 100), length = Number.parseInt(text(124, 136).trim(), 8);
    if (!Number.isSafeInteger(length) || length < 0 || offset + 512 + length > tar.length) throw new Error('Invalid locked libass package member.');
    if (files.some(filename => name === 'package/dist/js/' + filename)) {
      if (![0, 48].includes(header[156]) || members.has(name)) throw new Error('The actual font consumer is not an ordinary unique package member.');
      members.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + length)));
    }
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  await mkdir(output, { recursive: true });
  const packageRoot = path.join(output, 'package-original'); await mkdir(packageRoot);
  const assets = new Map(), descriptors = [];
  for (const filename of files) {
    const member = 'package/dist/js/' + filename, original = members.get(member);
    if (!original) throw new Error('A locked font consumer member is missing: ' + filename);
    const originalFile = path.join(packageRoot, filename); await writeFile(originalFile, original, { flag: 'wx' });
    const source = { archive, integrity: dependency.integrity, member, filename: originalFile, bytes: original.length, sha256: digest(original) };
    let bytes = original, runtime;
    if (filename !== 'subtitles-octopus.js') {
      const runtimeFile = path.join(web.runtime, 'libraries', filename);
      const bound = web.inputs.find(input => path.resolve(input.filename) === path.resolve(runtimeFile));
      bytes = await readFile(runtimeFile);
      if (!bound || bytes.length !== bound.bytes || digest(bytes) !== bound.sha256) throw new Error('The bound Web font worker asset changed: ' + filename);
      runtime = { filename: runtimeFile, bytes: bytes.length, sha256: digest(bytes) };
      // The production Web build optimizes copied JavaScript. Its actual bound
      // worker runs here; the binary source assets still retain their bytes.
      if (!filename.endsWith('.js') && !bytes.equals(original)) throw new Error('The Web font binary differs from its locked package: ' + filename);
    }
    const type = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.wasm') ? 'application/wasm' : 'font/woff2';
    assets.set('/font-consumer/' + filename, { bytes, type });
    await writeFile(path.join(output, filename), bytes, { flag: 'wx' });
    descriptors.push({ filename, bytes: bytes.length, sha256: digest(bytes), type, source, ...(runtime ? { runtime } : {}) });
  }
  const html = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Actual libass font consumer</title>
<video width="640" height="360"></video><output id="result">waiting</output>
<script src="/font-consumer/subtitles-octopus.js"></script><script>
window.fontCapture = { errorObserved: false, errors: [], messages: [] };
window.startFontCapture = function (options) {
  var target = new URL(options.path, location.origin).href;
  var workerUrl = location.origin + '/font-consumer/subtitles-octopus-worker.js';
  var fallbackFont = location.origin + '/font-consumer/default.woff2';
  var subContent = '[Script Info]\\nScriptType: v4.00+\\nPlayResX: 640\\nPlayResY: 360\\n[V4+ Styles]\\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\\nStyle: Default,Liberation Sans,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\\n[Events]\\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,font capture';
  if (options.mode === 'worker') {
    var worker = window.fontWorker = new Worker(workerUrl);
    worker.addEventListener('error', function (event) {
      fontCapture.errorObserved = true;
      fontCapture.errors.push({ message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno });
      document.querySelector('#result').textContent = 'font-worker-error';
    });
    worker.addEventListener('message', function (event) { fontCapture.messages.push(event.data); });
    worker.postMessage({ target: 'worker-init', preMain: true, width: 640, height: 360,
      URL: document.URL, currentScript: workerUrl, renderMode: 'wasm-blend', subContent: subContent,
      fonts: [target], availableFonts: {}, fallbackFont: fallbackFont, lazyFileLoading: false,
      debug: false, targetFps: 24, renderOnDemand: true });
  } else {
    window.fontRenderer = new SubtitlesOctopus({ video: document.querySelector('video'), subContent: subContent,
      fonts: [target], workerUrl: workerUrl, fallbackFont: fallbackFont,
      renderMode: 'wasm-blend', renderAhead: 90, targetFps: 24,
      onError: function (event) {
        fontCapture.errorObserved = true;
        fontCapture.errors.push({ message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno });
        document.querySelector('#result').textContent = 'libass-onError';
      } });
  }
};
</script>`);
  assets.set('/font-consumer/index.html', { bytes: html, type: 'text/html; charset=utf-8' });
  await writeFile(path.join(output, 'index.html'), html, { flag: 'wx' });
  descriptors.push({ filename: 'index.html', bytes: html.length, sha256: digest(html), type: 'text/html; charset=utf-8' });
  return { assets, descriptors, dependency: { ...dependency, archive, sha256: digest(compressed) } };
}
