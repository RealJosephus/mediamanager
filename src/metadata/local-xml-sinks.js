import path from 'node:path';
import { localXmlBufferSize } from './local-xml-writer.js';

const fileSink = handle => ({ async write(bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw new Error('The XML sink made no write progress.');
    offset += bytesWritten;
  }
} });

export async function directFileXmlSink(target, fileSystem) {
  const handle = await fileSystem.open(target, 'w');
  return { sink: fileSink(handle), close: () => handle.close() };
}

/** A state-owned disk spool supplies the exact HTTP Content-Length without
 * retaining the document in Node memory. It is a network upload source, not a
 * claim that PUT provides native Create/truncate or exclusive file access. */
export async function validateXmlSpoolRoot(root, fileSystem) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('Network XML saves require an absolute authorized state spool root.');
  }
  const info = await fileSystem.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('The XML spool root must be a non-symbolic directory.');
  return fileSystem.realpath(root);
}

export async function networkXmlSpool(root, fileSystem) {
  const directory = await fileSystem.mkdtemp(path.join(root, 'xml-save-'));
  const target = path.join(directory, 'frame.xml');
  let handle;
  try { handle = await fileSystem.open(target, 'wx'); }
  catch (error) { await fileSystem.rmdir(directory); throw error; }
  let closed = false, disposed = false;
  const readers = new Set();
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const errors = [];
    try { await close(); } catch (error) { errors.push(error); }
    for (const reader of readers) {
      try { await reader.close(); } catch (error) { errors.push(error); }
      readers.delete(reader);
    }
    try { await fileSystem.unlink(target); } catch (error) { errors.push(error); }
    try { await fileSystem.rmdir(directory); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'The XML spool could not be completely released.');
  };
  const prepare = async () => {
    if (disposed) throw new Error('The XML spool has been released.');
    await close();
    const size = (await fileSystem.stat(target, { bigint: true })).size;
    async function* stream() {
      if (disposed) throw new Error('The XML spool has been released.');
      const reader = await fileSystem.open(target, 'r');
      readers.add(reader);
      try {
        while (true) {
          const bytes = Buffer.allocUnsafe(localXmlBufferSize);
          const { bytesRead } = await reader.read(bytes, 0, bytes.length, null);
          if (!bytesRead) return;
          yield bytes.subarray(0, bytesRead);
        }
      } finally { if (readers.delete(reader)) await reader.close(); }
    }
    return Object.freeze({ size, stream, close: dispose });
  };
  return { sink: fileSink(handle), close, prepare, dispose,
    writeTextSync(value) {
      if(closed||disposed) throw new Error('The XML spool cannot accept more text.');
      for(let start=0;start<value.length;) {
        let end=Math.min(start+2048,value.length); if(end<value.length && /[\uD800-\uDBFF]/u.test(value[end-1]))end--;
        const bytes=Buffer.from(value.slice(start,end),'utf8');
        for(let offset=0;offset<bytes.length;) {const written=handle.writeSync(bytes.subarray(offset));if(!written)throw new Error('The XML spool made no write progress.');offset+=written;}
        start=end;
      }
    },
    async upload(vfs, destination, options = {}) {
      await close();
      const size = (await fileSystem.stat(target, { bigint: true })).size;
      const reader = await fileSystem.open(target, 'r');
      let readerClosed = false;
      const closeReader = async () => { if (!readerClosed) { readerClosed = true; await reader.close(); } };
      async function* chunks() {
        try {
          while (true) {
            // Each yielded chunk owns its bytes: the transport may prefetch
            // the next chunk before it finishes consuming the previous one.
            const bytes = Buffer.allocUnsafe(localXmlBufferSize);
            const { bytesRead } = await reader.read(bytes, 0, bytes.length, null);
            if (!bytesRead) return;
            yield bytes.subarray(0, bytesRead);
          }
        } finally { await closeReader(); }
      }
      const stream = chunks();
      try { return await vfs.write(destination, stream, { ...options, size }); }
      finally { try { await stream.return(); } finally { await closeReader(); } }
    },
  };
}
