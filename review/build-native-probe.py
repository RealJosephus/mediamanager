"""Generate only the new diagnostic module from intact, pinned production-fixture setup."""
from pathlib import Path
import sys
target = Path(sys.argv[1])
original = (target / 'tests/http/library-playback-native.test.js').read_text(encoding='utf-8')
def before(s):
    assert original.count(s) == 1, s
    return original.index(s)
def span(a,b):
    return original[before(a):before(b)]
code = """import { execFileSync } from 'node:child_process';
import { validationExecutable } from '../../tools/validation/paths.js';
import graphical from '../playback/fixtures/graphical-subtitle-reference.json' with { type: 'json' };
""" + original[:before('async function seed(')] + span('async function seed(', '  const databasePath = ') + """
  const vobFile = path.join(physical, 'Echo.mkv');
  const inputPgs = path.join(physical, 'audit-pgs.mks'), pgsFile = path.join(physical, 'Echo.sup');
  const sourceBytes = name => Buffer.from(graphical.sources.find(r => r.name === name).media, 'base64');
  await writeFile(vobFile, sourceBytes('vobsub.mks'));
  await writeFile(inputPgs, sourceBytes('pgs.mks'));
  execFileSync(validationExecutable('ffmpeg'), ['-nostdin','-loglevel','error','-i',inputPgs,'-map','0:s:0','-c','copy','-f','sup',pgsFile]);
""" + span('  const databasePath = ', "      for (const ItemId of [audioId") + """
      for (const [ItemId, StreamIndex, Codec, IsExternal, Path] of [
        [movies[0], 0, 'DVDSUB', false, null], [movies[1], 1, 'PGSSUB', true, pgsFile],
      ]) database.insert('MediaStreamInfos', postgresTestRow('MediaStreamInfos', {
        ItemId, StreamIndex, StreamType: 2, Codec, IsExternal, Path }));
""" + span("      for (const ItemId of [audioId", 'async function readResponse')
code = code.replace('return { settings, databasePath,', 'return { settings, pgsFile, vobFile, databasePath,')
code += """
async function collect(origin, token) {
  const data = {};
  async function get(route, headers = {}) {
    return fetch(origin + route, {headers:{Authorization: authorization(token), Connection:'close', ...headers}, signal:AbortSignal.timeout(60000)});
  }
  const capacity = await get('/System/Info/Storage');
  data.capacityStatus = capacity.status;
  const storage = await capacity.json();
  data.folders = Object.fromEntries(Object.entries(storage).filter(([name,value]) => name !== 'Libraries' && value && typeof value === 'object').map(([name, value]) => [name, {
    keys: Object.keys(value), pathNonempty: Boolean(value.Path), resolvedNonempty: Boolean(value.ResolvedPath),
    samePath: value.Path === value.ResolvedPath }]));
  const url = (item, index, extension) => '/Videos/' + idKey(item) + '/' + idKey(item) + '/Subtitles/' + index + '/Stream.' + extension;
  for (const [key, item, index, extension, range] of [
    ['vobFull', movies[0], 0, 'dvdsub'], ['pgsFull', movies[1], 1, 'pgssub'],
    ['pgsRange', movies[1], 1, 'pgssub', 'bytes=8-31'], ['supAlias', movies[1], 1, 'sup'],
  ]) {
    const response = await get(url(item, index, extension), range ? {Range:range} : {});
    const bytes = Buffer.from(await response.arrayBuffer());
    data[key] = {status:response.status, bytes:bytes.length, sha256:sha(bytes), type:response.headers.get('content-type'),
      contentRange:response.headers.get('content-range'), prefix:bytes.subarray(0,4).toString('hex')};
  }
  return data;
}
"""
p = original.index("test('existing playback assets")
code += original[p:before('    report.sources = ')] + """
    report.sources = await current.sourceBindings(['Jellyfin.Api/Controllers/SubtitleController.cs',
      'MediaBrowser.MediaEncoding/Subtitles/SubtitleEncoder.cs','MediaBrowser.Model/Entities/MediaStream.cs',
      'MediaBrowser.Model/System/FolderStorageInfo.cs','Jellyfin.Server.Implementations/StorageHelpers/StorageHelper.cs']);
""" + span('    await cp(current.sourceRoot', '    const frozenAudio = ') + """
    const files = [];
    for (const filename of [fixture.pgsFile, fixture.vobFile]) {
      const bytes = await readFile(filename);
      files.push({filename,contentType:'application/octet-stream',expected:{bytes:bytes.length,sha256:sha(bytes)}});
    }
    const input = await readFile(fixture.pgsFile);
    report.fixture = {pgsBytes:input.length,pgsHash:sha(input),rangeHash:sha(input.subarray(8,32))};
    proxy = await startOwnedMediaProxy(files);
""" + span('    report.nativeMedia = ', '    const ids = movies.map') + span('    native = current.start', '    const token = sample') + """
    report.native = await collect(nativeOrigin, current.accessToken);
""" + span('    await stopNative();\n    await writeFile', '    for (const entry of report.cases)') + """
    report.candidate = await collect(nodeOrigin, current.accessToken);
    const destination = path.join(validationOutputRoot(), 'review');
    await mkdir(destination,{recursive:true});
    await writeFile(path.join(destination, 'routes.json'), JSON.stringify(runtime.implementedRoutes, null, 2));
    await writeFile(path.join(destination, 'subtitle-storage.json'), JSON.stringify({fixture:report.fixture,native:report.native,candidate:report.candidate,
      sources:report.sources,proxyErrors:proxy.report.errors},null,2));
    assert.equal(report.candidate.pgsFull.sha256,report.fixture.pgsHash);
    assert.equal(report.native.pgsRange.sha256,report.fixture.rangeHash);
""" + original[before('  } catch (error) { primary = output.publicError(error); throw primary; }'):]
code = code.replace("library-playback-http-", "review-playback-http-")
code = code.replace("existing playback assets, date ticks, counts and search hints match the designated Native HTTP host","observe graphical subtitle bytes, ranges and storage paths at both HTTP hosts")
(target / 'tests/http/review-subtitle-probe.mjs').write_text(code, encoding='utf-8')

