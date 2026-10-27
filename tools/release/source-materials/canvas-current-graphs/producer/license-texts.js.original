import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const materialsPath = 'tools/release/license-materials';
const companionPackages = new Map([
  ['koffi', '@koromix/koffi-'],
  ['@napi-rs/canvas', '@napi-rs/canvas-'],
]);

export function completeMitText(text) {
  const normalized = text.replace(/\s+/gu, ' ').toLowerCase();
  return normalized.includes('copyright')
    && normalized.includes('permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "software"), to deal in the software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the software, and to permit persons to whom the software is furnished to do so, subject to the following conditions:')
    && normalized.includes('the above copyright notice and this permission notice shall be included in all copies or substantial portions of the software.')
    && normalized.includes('the software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. in no event shall the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of contract, tort or otherwise, arising from, out of or in connection with the software or the use or other dealings in the software.');
}

export async function resolveDependencyLicenseTexts(root, packages, manifests) {
  const catalog = JSON.parse(await readFile(path.join(root, materialsPath, 'index.json'), 'utf8'));
  const documents = new Map(catalog.documents.map(document => [document.path, document]));
  const verified = new Set();
  async function documentPath(filename) {
    const document = documents.get(filename);
    if (!document) throw new Error('Unknown dependency license material: ' + filename);
    const relative = path.posix.join(materialsPath, filename);
    if (!verified.has(filename)) {
      const content = await readFile(path.join(root, relative));
      if (content.length !== document.bytes || createHash('sha256').update(content).digest('hex') !== document.sha256) {
        throw new Error('Dependency license material changed: ' + relative);
      }
      verified.add(filename);
    }
    return relative;
  }
  for (const pkg of packages) {
    if (pkg.distribution.workspace) continue;
    for (const source of catalog.packages.filter(entry => entry.name === pkg.name && entry.version === pkg.version
      && entry.integrity === pkg.distribution.integrity && entry.license === pkg.license)) {
      const metadataPath = await documentPath(source.metadata);
      const metadata = JSON.parse(await readFile(path.join(root, metadataPath), 'utf8'));
      if (metadata.name !== pkg.name || metadata.version !== pkg.version || metadata.license !== pkg.license
        || metadata.dist.integrity !== pkg.distribution.integrity || metadata.gitHead !== source.gitHead) {
        throw new Error('Dependency license source does not match its distribution: ' + pkg.name);
      }
      const licenseTexts = await Promise.all(source.licenseTexts.map(documentPath));
      const notices = await Promise.all((source.notices ?? []).map(documentPath));
      pkg.licenses.push(...licenseTexts, ...notices);
      pkg.licenseTexts.push(...licenseTexts);
      pkg.licenseSources = [{ metadata: metadataPath, gitHead: source.gitHead, licenseTexts, notices }];
    }
  }
  for (const [ownerName, prefix] of companionPackages) {
    const owner = packages.find(pkg => pkg.name === ownerName), manifest = manifests.get(owner?.path);
    if (!owner || !owner.licenseTexts.length) continue;
    for (const pkg of packages) {
      if (!pkg.name.startsWith(prefix) || pkg.version !== owner.version || pkg.license !== owner.license
        || manifest.optionalDependencies?.[pkg.name] !== pkg.version) continue;
      pkg.licenseTexts.push(...owner.licenseTexts);
      pkg.licenses.push(...owner.licenseTexts);
      pkg.licenseSources = [{ package: owner.path, version: owner.version, licenseTexts: owner.licenseTexts }];
    }
  }
  return packages.filter(pkg => !pkg.distribution.workspace && !pkg.licenseTexts.length).map(pkg => pkg.path);
}
