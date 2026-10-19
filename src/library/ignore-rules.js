import { clrTrim, clrWhitespace } from '../metadata/whitespace.js';
import { compileNativeIgnoreRegex, foldNativeIgnoreCase } from '../core/native-ignore-regex.js';

// Ordered replacers from Ignore 0.2.1. See resources/ignore-license.txt.
const replacements = [
  [new RegExp('\\\\?[' + clrWhitespace + ']+$', 'g'), match => match.startsWith('\\') ? ' ' : ''],
  [new RegExp('\\\\[' + clrWhitespace + ']', 'g'), () => ' '],
  [/\./g, () => '\\.'], [/\+/g, () => '\\+'],
  [/(?!\\)\?/g, () => '[^/]'],
  [/(^[^/]*$)/g, (_, one) => '(^|/)' + one],
  [/(?<!^)(?<!\*)\*(?!\*)/g, () => '[^/]*'],
  [/^(?<!\*)\*(?!\*)/g, () => '.*'],
  [/^(\*\*\/|\*\*)/g, () => '.*'],
  [/(?<=\/)\*\*\//g, () => '(.*/)?'],
  [/^\//g, () => '^'],
  [/\*\*$/g, () => '.*$'],
  [/\*\*/g, () => '[^/]*'],
  [/^([^/^]+\/[^/]+)/g, (_, one) => '^' + one],
  [/^([^/]+)\/$/g, (_, one) => '(/|^)' + one + '/'],
  [/([^/$]+)$/g, (_, one) => one + '(/.*)?$'],
  [/([^/$]+)$/g, (_, one) => one + '$']
];

function parseRule(pattern) {
  if (typeof pattern !== 'string') throw new TypeError('An ignore pattern must be a string.');
  if (!clrTrim(pattern) || pattern.startsWith('#')) return { negate: false, expression: null };
  let negate = false;
  if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) pattern = pattern.slice(1);
  else if (pattern.startsWith('!')) { negate = true; pattern = pattern.slice(1); }
  for (const [expression, replace] of replacements) pattern = pattern.replace(expression, replace);
  return { negate, expression: compileNativeIgnoreRegex(pattern) };
}

export class NativeIgnoreRules {
  #rules = [];
  constructor(patterns) {
    for (const pattern of patterns) {
      try { this.#rules.push(parseRule(pattern)); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
  }
  get isEmpty() { return this.#rules.length === 0; }
  isIgnored(identityPath, { isDirectory = false, normalizePath = process.platform === 'win32' } = {}) {
    if (this.isEmpty) return true;
    let path = normalizePath ? identityPath.replaceAll('\\', '/') : identityPath;
    if (isDirectory) path = path.replace(/\/+$/, '') + '/';
    path = foldNativeIgnoreCase(path);
    let ignored = false;
    for (const rule of this.#rules) if (rule.expression?.test(path)) ignored = !rule.negate;
    return ignored;
  }
}
