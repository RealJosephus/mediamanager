import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This extractor is deliberately
// restricted to the constructs present in the pinned source, and rejects new ones.
const stringTokens = (value) => [...value.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(([token]) => JSON.parse(token));
export function extractModel(snapshot) {
  const entities = new Map();
  const blocks = [...snapshot.matchAll(/modelBuilder\.Entity\("([^"]+)", b =>\s*\{([\s\S]*?)^\s{16}\}\);/gm)];
  if (!blocks.length) throw new Error('No EF entity blocks found');
  for (const [, entity, body] of blocks) {
    const table = body.match(/b\.ToTable\("([^"]+)"(?:, \(string\)null)?\)/)?.[1];
    if (!table) continue;
    const primaryKey = stringTokens(body.match(/b\.HasKey\(([^;]+)\);/)?.[1] ?? '');
    if (!primaryKey.length) throw new Error(`Missing primary key: ${entity}`);
    const columns = [...body.matchAll(/b\.(Property|PrimitiveCollection)<([^>]+)>\("([^"]+)"\)([\s\S]*?);/g)].map(([, kind, clrType, name, tail]) => {
      const type = tail.match(/\.HasColumnType\("([^"]+)"\)/)?.[1];
      if (!['TEXT', 'INTEGER', 'REAL', 'BLOB'].includes(type)) throw new Error(`Unsupported column type ${entity}.${name}: ${type}`);
      const baseType = clrType.replace(/\?$/, '');
      const nullable = !primaryKey.includes(name) && !tail.includes('.IsRequired()') && (clrType.endsWith('?') || ['string', 'byte[]'].includes(baseType));
      const pgType = type === 'TEXT' ? 'text' : type === 'BLOB' ? 'bytea' : type === 'REAL' ? 'double precision' : baseType === 'bool' ? 'boolean' : ['long', 'uint'].includes(baseType) ? 'bigint' : 'integer';
      const unknown = [...tail.matchAll(/\.(\w+)\(/g)].map((match) => match[1]).filter((method) => !['HasColumnType', 'IsRequired', 'HasMaxLength', 'ValueGeneratedOnAdd', 'IsConcurrencyToken'].includes(method));
      if (unknown.length) throw new Error(`Unsupported EF property configuration: ${unknown.join(', ')}`);
      return { name, clrType, type, pgType, nullable, generated: type === 'INTEGER' && tail.includes('.ValueGeneratedOnAdd()'), concurrency: tail.includes('.IsConcurrencyToken()'), ...(kind === 'PrimitiveCollection' ? { primitiveCollection: true } : {}) };
    });
    const indices = [...body.matchAll(/b\.HasIndex\(([^;]*?)\)([\s\S]*?);/g)].map(([, args, tail]) => {
      const names = stringTokens(args);
      const filterMatch = tail.match(/\.HasFilter\(("(?:[^"\\]|\\.)*")\)/);
      return { name: `IX_${table}_${names.join('_')}`, columns: names, unique: tail.includes('.IsUnique()'), filter: filterMatch ? JSON.parse(filterMatch[1]) : null };
    });
    if (columns.length !== [...body.matchAll(/b\.(?:Property|PrimitiveCollection)</g)].length) throw new Error(`Unparsed columns: ${entity}`);
    const unknown = [...body.matchAll(/b\.(\w+)(?:<[^>]+>)?\(/g)].map((match) => match[1]).filter((method) => !['Property', 'PrimitiveCollection', 'HasKey', 'HasIndex', 'ToTable', 'HasAnnotation', 'HasData'].includes(method));
    if (unknown.length) throw new Error(`Unsupported EF entity configuration: ${unknown.join(', ')}`);
    entities.set(entity, { name: table, entity, columns, primaryKey, indices, foreignKeys: [] });
  }
  for (const [, entity, body] of blocks) {
    for (const [, target, tail] of body.matchAll(/b\.HasOne\("([^"]+)", [^\n]+\)([\s\S]*?);/g)) {
      const owner = entities.get(entity);
      const referenced = entities.get(target);
      if (!owner || !referenced) throw new Error(`Unknown relationship: ${entity} -> ${target}`);
      const args = stringTokens(tail.match(/\.HasForeignKey\(([^)]+)\)/)?.[1] ?? '');
      const columns = args.filter((name) => name !== entity);
      if (!columns.length || columns.some((name) => !owner.columns.some((column) => column.name === name))) throw new Error(`Unknown foreign key: ${entity}`);
      const onDelete = tail.match(/\.OnDelete\(DeleteBehavior\.(\w+)\)/)?.[1];
      if (!['Cascade', 'NoAction'].includes(onDelete)) throw new Error(`Unsupported delete action: ${onDelete}`);
      owner.foreignKeys.push({ columns, table: referenced.name, referencedColumns: referenced.primaryKey, onDelete: onDelete === 'Cascade' ? 'CASCADE' : 'NO ACTION' });
    }
  }
  return [...entities.values()].sort((a, b) => a.name < b.name ? -1 : 1);
}

export async function generateModel(sourceRoot, destination) {
  const migrationRoot = path.join(sourceRoot, 'src/Jellyfin.Database/Jellyfin.Database.Providers.Sqlite/Migrations');
  const snapshot = await readFile(path.join(migrationRoot, 'JellyfinDbModelSnapshot.cs'), 'utf8');
  const tables = extractModel(snapshot);
  const migrations = (await readdir(migrationRoot)).filter((name) => /^\d{14}_.+(?<!\.Designer)\.cs$/.test(name)).sort();
  const sources = [];
  const migrationIds = [];
  for (const filename of ['JellyfinDbModelSnapshot.cs', ...migrations]) {
    const content = await readFile(path.join(migrationRoot, filename));
    sources.push({ path: `src/Jellyfin.Database/Jellyfin.Database.Providers.Sqlite/Migrations/${filename}`, sha256: createHash('sha256').update(content).digest('hex') });
    if (filename !== 'JellyfinDbModelSnapshot.cs') {
      const designer = await readFile(path.join(migrationRoot, filename.replace('.cs', '.Designer.cs')), 'utf8');
      const id = designer.match(/\[Migration\("([^"]+)"\)\]/)?.[1];
      if (!id) throw new Error(`Missing migration identifier: ${filename}`);
      migrationIds.push(id);
    }
  }
  const dataMigrations = [];
  for (const folder of ['Routines', 'PreStartupRoutines']) for (const filename of (await readdir(path.join(sourceRoot, 'Jellyfin.Server/Migrations', folder))).filter((name) => name.endsWith('.cs'))) {
    const relative = `Jellyfin.Server/Migrations/${folder}/${filename}`;
    const content = await readFile(path.join(sourceRoot, relative), 'utf8');
    for (const [, timestamp, name] of content.matchAll(/\[JellyfinMigration\("([^"]+)", nameof\(([^)]+)\)/g)) dataMigrations.push(`${timestamp.replace(/[-T:]/g, '')}_${name}`);
    sources.push({ path: relative, sha256: createHash('sha256').update(content).digest('hex') });
  }
  // Defaults introduced by migration operations remain in SQLite even though the
  // EF model snapshot no longer declares them. Verified against a runtime EF database.
  for (const [table, column, value] of [['DisplayPreferences', 'ItemId', "'00000000-0000-0000-0000-000000000000'"], ['MediaStreamInfos', 'IsOriginal', '0'], ['Users', 'NormalizedUsername', "''"]]) tables.find((entry) => entry.name === table).columns.find((entry) => entry.name === column).default = value;
  const expressionSource = await readFile(path.join(migrationRoot, '20260728170000_AddPeopleNameLowerIndex.cs'), 'utf8');
  const expressionSql = stringTokens(expressionSource.match(/migrationBuilder\.Sql\(("(?:[^"\\]|\\.)*")\)/)?.[1] ?? '')[0];
  if (expressionSql !== 'CREATE INDEX IF NOT EXISTS "IX_Peoples_NameLower" ON "Peoples" (lower("Name"));') throw new Error('Expression index source changed');
  tables.find((table) => table.name === 'Peoples').indices.push({ name: 'IX_Peoples_NameLower', columns: [], expression: 'lower("Name")', unique: false, filter: null });
  const model = { evidence: 'source-derived with three migration-retained defaults; validated against isolated EF runtime schema', efProductVersion: snapshot.match(/HasAnnotation\("ProductVersion", "([^"]+)"\)/)?.[1], tables, migrations: migrationIds.sort(), dataMigrations: dataMigrations.sort(), sources };
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(model, null, 2)}\n`);
  return model;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const model = await generateModel(process.argv[2] ?? 'D:/jellyfin', process.argv[3] ?? 'src/database/native-model.json');
  console.log(JSON.stringify({ tables: model.tables.length, columns: model.tables.reduce((count, table) => count + table.columns.length, 0), migrations: model.migrations.length }));
}
