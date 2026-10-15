import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { quoteIdentifier as q } from './model.js';

const source = readFileSync(new URL('./native-text-functions.sql', import.meta.url), 'utf8');
const names = [...new Set([...source.matchAll(/CREATE FUNCTION (mm_[a-z0-9_]+)\(/g)].map(match => match[1]))];
export const nativeTextFunctionNames = Object.freeze(names);
export const nativeTextFunctionsSha256 = createHash('sha256').update(source).digest('hex');
export const nativeTextFunctionDefinitions = Object.freeze([...source.matchAll(
  /CREATE FUNCTION (mm_[a-z0-9_]+)\(([^\n]*?)\) RETURNS ([^\n]+)\r?\nLANGUAGE (\w+) IMMUTABLE STRICT PARALLEL SAFE AS \$\$([\s\S]*?)\$\$;/g,
)].map(([, name, parameters, resultType, language, body]) => Object.freeze({ name, parameters,
  inputTypes: parameters.split(',').map(parameter => parameter.trim().split(/\s+/u)[1]).join(', '),
  resultType: resultType.trim(), language, body })));
if (nativeTextFunctionDefinitions.length !== [...source.matchAll(/CREATE FUNCTION /g)].length) throw new Error('A native TEXT function definition is incomplete.');

export function qualifyNativeTextSql(schema, body) {
  for (const name of names) body = body.replaceAll(new RegExp(`\\b${name}\\(`, 'g'), `${q(schema)}.${q(name)}(`);
  return body;
}

/** All nested calls are explicit schema references; the pinned functions
 * consume bytea authority or a canonical derived projection only. */
export function nativeTextFunctionStatements(schema) {
  if (typeof schema !== 'string' || !schema) throw new TypeError('Native TEXT functions require a schema.');
  let rendered = qualifyNativeTextSql(schema, source);
  rendered = rendered.replaceAll('PARALLEL SAFE AS', 'PARALLEL SAFE SET search_path = pg_catalog AS');
  return rendered;
}

export function assertNativeTextFunctionDefinitions(snapshot, schema) {
  for (const definition of nativeTextFunctionDefinitions) {
    const entry = snapshot.functions.find(candidate => candidate.function_name === definition.name
      && candidate.input_types === definition.inputTypes);
    if (!entry || entry.source !== qualifyNativeTextSql(schema, definition.body)
      || entry.language !== definition.language || entry.volatility !== 'i' || !entry.is_strict
      || entry.security_definer || entry.leakproof || entry.parallel_safety !== 's' || entry.kind !== 'f'
      || !entry.executable || JSON.stringify(entry.configuration) !== JSON.stringify(['search_path=pg_catalog'])) {
      throw new Error(`Native TEXT SQL function differs: ${definition.name}(${definition.inputTypes})`);
    }
  }
}
