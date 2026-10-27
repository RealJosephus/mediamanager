import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function tar(args, cwd) {
  const child = spawn('tar', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let error, stderr = '';
  child.once('error', value => { error = value; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
  const settled = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, settled, async finish() {
    const { code, signal } = await settled;
    if (error) throw error;
    if (code !== 0 || signal) throw new Error(`Original native source archive read failed (${signal ?? code}): ${stderr}`);
  } };
}

export async function readNativeSourceArchive(filename, members, capture, work) {
  const archive = path.relative(work, filename).split(path.sep).join('/'), canonical = name => name.replace(/\/$/u, '');
  const listing = tar(['-tf', archive], work); listing.child.stdout.setEncoding('utf8');
  let output = '', outputBytes = 0;
  try {
    for await (const chunk of listing.child.stdout) {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 16 * 1024 * 1024) throw new Error('Original native source member listing exceeds its complete bound.');
      output += chunk;
    }
    await listing.finish();
  } catch (error) { listing.child.kill(); await listing.settled; throw error; }
  const expected = new Map(members.map(member => [canonical(member.path), member]));
  const names = output.split(/\r?\n/u).filter(Boolean).map(canonical);
  if (expected.size !== members.length || names.length !== members.length || new Set(names).size !== names.length || names.some(name => !expected.has(name))) {
    throw new Error('Complete original native source archive membership changed.');
  }
  const files = names.map(name => expected.get(name)).filter(member => member.kind === 'file');
  if (!files.length || files.some(file => /[\r\n\0]/u.test(file.path))) throw new Error('Original native source file selection is incomplete.');
  const selector = path.join(work, 'regular-members.txt'); await writeFile(selector, files.map(file => file.path).join('\n') + '\n', { flag: 'wx' });
  const extraction = tar(['-xOf', archive, '-T', path.basename(selector)], work), wanted = new Set(capture), captured = new Map();
  let index = 0, size = 0, hash = createHash('sha256'), blob = createHash('sha1').update(`blob ${files[0].bytes}\0`), chunks = [];
  const finish = () => {
    const member = files[index];
    if (hash.digest('hex') !== member.sha256 || blob.digest('hex') !== member.gitBlob) throw new Error('Original native source member bytes changed: ' + member.path);
    if (wanted.has(member.path)) captured.set(member.path, Buffer.concat(chunks));
    index += 1; size = 0; chunks = []; hash = createHash('sha256');
    if (index < files.length) blob = createHash('sha1').update(`blob ${files[index].bytes}\0`);
  };
  try {
    for await (const chunk of extraction.child.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        while (index < files.length && size === files[index].bytes) finish();
        if (index === files.length) throw new Error('Original native source emitted bytes outside its complete member set.');
        const length = Math.min(chunk.length - offset, files[index].bytes - size), part = chunk.subarray(offset, offset + length);
        hash.update(part); blob.update(part);
        if (wanted.has(files[index].path)) chunks.push(Buffer.from(part));
        size += length; offset += length;
      }
    }
    await extraction.finish();
    while (index < files.length && size === files[index].bytes) finish();
    if (index !== files.length || [...wanted].some(name => !captured.has(name))) throw new Error('Complete original native source file stream is incomplete.');
  } catch (error) { extraction.child.kill(); await extraction.settled; throw error; }
  return captured;
}
