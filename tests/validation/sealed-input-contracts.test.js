import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { captureInputIdentity, executionManifestContract, executionManifestReferences } from '../../tools/validation/inputs.js';
import { repositoryRoot } from '../../tools/validation/paths.js';

const consumers = [
  'tests/core/native-charset.test.js', 'tests/core/native-json-encoder.test.js',
  'tests/http/item-deletion.test.js', 'tests/library/delete-dto-permission.test.js',
  'tests/library/native-item-cache.test.js', 'tests/library/warm-item-deletion.test.js', 'tests/http/warm-item-deletion.test.js',
];
const entry = (filename, imports = []) => ({ path: filename, test: filename.endsWith('.test.js'), imports,
  importedFiles: [], declaredReferences: [], fixtureReferences: [], services: [], tools: [], unresolvedImports: [] });

test('the seven directory-based seal consumers capture their original sources, runtime pins and local inputs with exact ownership', async () => {
  const unrelated = 'tests/core/composite-format.test.js', shared = 'tests/library/warm-fixture-seal.js';
  const dependencies = { entries: [...consumers.map(consumer => {
    const { loader } = executionManifestContract(consumer);
    return entry(consumer, loader === consumer ? [] : [loader]);
  }), entry(shared), entry(unrelated, [shared])] };
  const identity = await captureInputIdentity({ selected: [...consumers, unrelated], dependencies, environment: {},
    preflight: { ready: true, services: [], tools: [] } });
  for (const consumer of consumers) {
    const contract = executionManifestContract(consumer), filename = path.join(repositoryRoot, contract.manifest);
    const proof = JSON.parse(await readFile(filename, 'utf8'));
    const required = (filename, pin) => {
      const input = identity.entries.find(value => value.filename === path.resolve(repositoryRoot, filename));
      assert.ok(input?.required, filename);
      assert.ok(input.requiredReasons.some(reason => reason.startsWith(consumer + ':')), consumer + ': ' + filename);
      assert.ok(!input.requiredReasons.some(reason => reason.startsWith(unrelated + ':') || reason.startsWith(shared + ':')),
        'importing the warm loader does not require another caller\'s recording');
      if (pin) assert.ok(input.expectedDigests.includes(pin), filename);
    };
    required(filename);
    if (consumer === 'tests/core/native-charset.test.js') {
      required(proof.record.filename, proof.record.sha256);
      required(proof.repeat.raw.filename, proof.repeat.raw.sha256);
      required(proof.dotnet.filename, proof.dotnet.sha256);
      for (const source of proof.upstream.sources) required(source.filename ?? source.path, source.sha256);
      for (const assembly of proof.loadedAssemblies) required(assembly.filename ?? assembly.path, assembly.sha256);
      required(path.join(path.dirname(filename), 'native.json'), proof.native.sha256);
    } else {
      for (const descriptor of Object.values(proof.files)) required(path.resolve(path.dirname(filename), descriptor.filename), descriptor.sha256);
      required(proof.files.rawRecording.filename, proof.files.rawRecording.sha256);
      required(proof.repeat.filename, consumer === 'tests/http/item-deletion.test.js' ? proof.repeat.rawSha256 : proof.repeat.sha256);
      if (contract.kind === 'sealed-warm') {
        for (const descriptor of [proof.jellyfin.sourceCapture, proof.jellyfin.boundBuildAudit,
          ...Object.values(proof.runtime), ...Object.values(proof.repeat.runtime)]) required(descriptor.filename, descriptor.sha256);
      } else if (contract.kind === 'sealed-json') {
        for (const descriptor of [proof.jellyfin.assembly, proof.runtime.dotnet, proof.runtime.oracleAssembly]) required(descriptor.filename, descriptor.sha256);
      } else if (contract.kind === 'sealed-delete-dto') required(proof.sourceControl.path, proof.sourceControl.sha256);
      for (const assembly of proof.assemblies ?? []) required(proof.jellyfin.assemblyDirectory + '/' + assembly.name + '.dll', assembly.sha256);
    }
  }
});

test('HTTP deletion binds its raw repeat digest without promoting the unread repeat receipt or unrelated provenance', () => {
  const sha256 = 'a'.repeat(64), rawSha256 = 'b'.repeat(64), ignoredSha256 = 'c'.repeat(64);
  const filename = path.join(repositoryRoot, 'tests/http/fixtures/item-deletion/provenance.json');
  const raw = { filename: 'D:/recordings/original.raw.json', sha256 };
  const references = executionManifestReferences({ kind: 'sealed-http-delete' }, {
    files: { input: { filename: 'input.json', sha256 }, rawRecording: raw },
    repeat: { filename: 'D:/recordings/repeat.raw.json', rawSha256,
      record: { filename: 'D:/unread/receipt.json', sha256: ignoredSha256 } },
    jellyfin: { assemblyDirectory: 'D:/native' }, assemblies: [{ name: 'MediaBrowser.Controller', sha256 }],
    unrelated: { filename: 'D:/unread/source.json', sha256: ignoredSha256 }, Path: 'Z:\\Movies\\movie.mkv',
  }, filename);
  assert.ok(references.some(reference => reference.filename === 'D:/recordings/repeat.raw.json' && reference.sha256 === rawSha256));
  assert.ok(references.some(reference => reference.filename === raw.filename && reference.sha256 === sha256));
  assert.ok(references.some(reference => reference.filename === path.resolve(path.dirname(filename), raw.filename)));
  assert.ok(references.some(reference => reference.filename === 'D:/native/MediaBrowser.Controller.dll'));
  assert.ok(!references.some(reference => reference.filename.startsWith('D:/unread/') || reference.filename.startsWith('Z:')));
});
