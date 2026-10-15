import { validationOutputRoot, validationPath } from '../validation/paths.js';
import { cp, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel } from '../../src/database/model.js';

const [scenario, candidateDirectory, output, portText] = process.argv.slice(2);
const root = path.resolve(output);
if (!root.startsWith(validationOutputRoot() + path.sep)) throw new Error('Return validation requires an isolated evidence directory.');
const port = Number(portText);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('An explicit isolated port is required.');
await mkdir(root, { recursive: false });
const sourceRoot = path.resolve(scenario, 'reference');
await cp(sourceRoot, root, { recursive: true });
await cp(path.join(candidateDirectory, 'returned.db'), validationPath(path.join(root, 'data/data/jellyfin.db')));
const replace = text => text.replaceAll(sourceRoot.replaceAll('\\', '\\\\'), root.replaceAll('\\', '\\\\')).replaceAll(sourceRoot, root).replaceAll(sourceRoot.replaceAll('\\', '/'), root.replaceAll('\\', '/'));
async function updateFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await updateFiles(filename);
    else if (/\.(?:xml|json)$/i.test(entry.name)) {
      const before = await readFile(filename, 'utf8');
      let after = replace(before);
      if (entry.name === 'network.xml') after = after.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/g, (_, tag) => `<${tag}>${port}</${tag}>`);
      if (before !== after) await writeFile(filename, after);
    }
  }
}
await updateFiles(validationPath(path.join(root, 'config')));
const database = new SqliteDatabase(validationPath(path.join(root, 'data/data/jellyfin.db')), { requireMigrationHistory: true });
database.transaction(() => {
  for (const table of nativeModel.tables) for (const row of database.rows(table.name)) {
    const changes = Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value === 'string' && value !== replace(value)).map(([key, value]) => [key, replace(value)]));
    if (Object.keys(changes).length) database.update(table.name, Object.fromEntries(table.primaryKey.map(key => [key, row[key]])), changes);
  }
});
database.close();
await writeFile(validationPath(path.join(root, 'return-preparation.json')), JSON.stringify({ source: path.resolve(candidateDirectory), checkedAt: new Date().toISOString(), port, nativePathsRebased: true, mediaAccessVerified: false }, null, 2));
console.log(JSON.stringify({ prepared: root, port }));
