import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { describeFile } from './inventory.js';
import { repositoryRoot } from './paths.js';

const version = '1.64.0';
const revision = '1248';
const browserVersion = '156.0.8078.4';

/** Bind the installed browser that the real Web consumer will launch. */
export async function browserInputs(environment = process.env) {
  const root = environment.PLAYWRIGHT_BROWSERS_PATH;
  const executable = environment.MEDIAMANAGER_BROWSER_EXECUTABLE;
  if (environment.MEDIAMANAGER_CI_WEB_CLIENTS !== 'true' || !root || !path.isAbsolute(root)
    || !executable || !path.isAbsolute(executable)) {
    throw new Error('Web acceptance requires explicit browser provisioning and absolute installation paths.');
  }
  const inputs = [];
  const bind = async filename => {
    const value = await describeFile(filename);
    if (!value.available || value.kind !== 'file' || !value.sha256) throw new Error(`Browser input is missing: ${filename}`);
    inputs.push({ filename, sha256: value.sha256 });
    return JSON.parse(await readFile(filename, 'utf8'));
  };
  // These are installed runtime inputs, not historical recording fixtures.
  // bind() below and the strict node_modules tree both retain their actual bytes.
  const manifest = path.join(repositoryRoot, 'node_modules', 'playwright', 'package.json');
  const coreManifest = path.join(repositoryRoot, 'node_modules', 'playwright-core', 'package.json');
  if ((await bind(manifest)).version !== version || (await bind(coreManifest)).version !== version) {
    throw new Error('The Web consumer requires the pinned Playwright implementation.');
  }
  const registry = await bind(path.join(path.dirname(coreManifest), 'browsers.json'));
  const chromiumEntry = registry.browsers.find(browser => browser.name === 'chromium');
  if (chromiumEntry?.revision !== revision || chromiumEntry.browserVersion !== browserVersion) {
    throw new Error('The installed Playwright registry has a different Chromium identity.');
  }
  // executablePath is a public path lookup, not a browser launch. Use the same
  // real environment as the subsequent launch instead of guessing OS filenames.
  const { chromium } = await import('playwright');
  if (path.resolve(chromium.executablePath()) !== path.resolve(executable)
    || path.resolve(environment.PLAYWRIGHT_BROWSERS_PATH) !== path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '')) {
    throw new Error('The declared browser differs from the actual Playwright selection.');
  }
  const relative = path.relative(path.join(root, `chromium-${revision}`), executable);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || await realpath(executable) !== path.resolve(executable)) {
    throw new Error('Chromium must be an ordinary file in its explicitly supplied revision directory.');
  }
  const tree = await describeFile(root);
  if (!tree.available || tree.kind !== 'directory') throw new Error('The browser installation is incomplete or contains unsupported links.');
  inputs.push({ filename: root, sha256: tree.entriesSha256 });
  const visit = (entry, filename) => {
    if (entry.kind === 'directory') for (const child of entry.entries) visit(child, path.join(filename, child.name));
    else if (entry.kind === 'file' && entry.sha256) inputs.push({ filename, sha256: entry.sha256 });
    else throw new Error('The browser installation contains an unsupported member.');
  };
  visit(tree, root);
  if (!inputs.some(input => path.resolve(input.filename) === path.resolve(executable))) throw new Error('The supplied browser executable is missing.');
  return { root, executable, revision, browserVersion, inputs };
}
