import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { userDataBindingCases } from '../../tests/sessions/user-data-binding-cases.js';

const [dotnet, oracle, assemblies, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: record-user-data-binding DOTNET ORACLE_DLL ASSEMBLY_DIRECTORY NEW_OUTPUT');
const cases = userDataBindingCases();
const result = spawnSync(dotnet, [oracle, assemblies], { input: cases.map(entry => entry.source).join('\n') + '\n', encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
await writeFile(`${output}.stdout.jsonl`, result.stdout, { flag: 'wx' });
if (result.status !== 0) throw new Error(result.stderr);
const lines = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, '')));
if (lines.length !== cases.length) throw new Error('Oracle result count does not match its inputs.');
await writeFile(output, JSON.stringify({ environment: { platform: process.platform, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, cases: cases.map((entry, index) => ({ ...entry, expected: lines[index] })) }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ cases: lines.length, accepted: lines.filter(entry => !entry.error).length, rejected: lines.filter(entry => entry.error).length }));
