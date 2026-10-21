import { BindingError } from './binding.js';
import { nativeGuid } from '../users/native.js';
import { withNativeNulls } from '../core/json.js';
import { tokenizeJson } from '../core/json-tokens.js';
import { parseJsonDateTime } from './json-date-time.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

export function bindJsonModel(body, { schema, root, source = body?.[Symbol.for('mediamanager.jsonSource')], caseInsensitiveProperties = true } = {}) {
  source ??= JSON.stringify(body, (_key,value)=>typeof value==='bigint'?JSON.rawJSON(value.toString()):value);
  JSON.parse(source);
  function convert(node, rule, path, baseOffset = 0) {
    const { value } = node;
    const nestedNullable = rule.nullable && ['boolean','integer','long','double','float','datetime'].includes(rule.type);
    const consumed = node.properties || node.items ? node.start + 1 : node.end;
    const failure = (message, failureEnd = consumed) => {
      const errorPath = nestedNullable ? '$' : path;
      const text = nestedNullable ? source.slice(node.start,failureEnd) : source.slice(baseOffset,failureEnd);
      const line = text.split('\n').length - 1;
      const position = Buffer.byteLength(text.slice(text.lastIndexOf('\n')+1));
      const type = rule.nullable && rule.type === 'guid' ? `System.Nullable\`1[${rule.clrType}]` : rule.clrType;
      message ??= `The JSON value could not be converted to ${type}.`;
      const error = new BindingError(errorPath,`${message} Path: ${errorPath} | LineNumber: ${line} | BytePositionInLine: ${position}.`);
      Object.assign(error,{ nativeException:'JsonException',path:errorPath,line,position });
      throw error;
    };
    if (value === null && !node.properties && !node.items && Object.hasOwn(rule, 'nullAsDefault')) return structuredClone(rule.nullAsDefault);
    if (value === null && !node.properties && !node.items || value === '' && nestedNullable) {
      if (rule.nullable) return null;
      return failure();
    }
    if (rule.type === 'string') {
      if (node.properties || node.items) return failure("The converter 'Jellyfin.Extensions.Json.Converters.JsonStringConverter' read too much or not enough.");
      if (typeof value === 'string' && !value.isWellFormed()) return failure();
      return typeof value === 'string' ? value : source.slice(node.start,node.end);
    }
    if (rule.type === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (rule.allowString && typeof value === 'string' && /^(?:true|false)$/iu.test(clrTrim(value))) return clrTrim(value).toLowerCase() === 'true';
      return failure();
    }
    if (rule.type === 'datetime') {
      try { return parseJsonDateTime(value); }
      catch (error) { if (error instanceof RangeError || error instanceof TypeError) return failure(); throw error; }
    }
    if (rule.type === 'integer' || rule.type === 'long') {
      const text = typeof value === 'string' ? value : source.slice(node.start,node.end);
      if (!/^[+-]?\d+$/.test(text) || typeof value === 'boolean') return failure();
      const number = BigInt(text), min = rule.type === 'long' ? -9223372036854775808n : -2147483648n, max = rule.type === 'long' ? 9223372036854775807n : 2147483647n;
      if (number < min || number > max) return failure();
      return rule.type === 'long' ? number : Number(number);
    }
    if (rule.type === 'double' || rule.type === 'float') {
      const numeric = number => rule.type === 'float' ? Math.fround(number) : number;
      if (typeof value === 'number') return numeric(value);
      if (typeof value === 'bigint') return numeric(Number(value));
      if (typeof value !== 'string') return failure();
      if (['NaN', 'Infinity', '-Infinity'].includes(value)) return numeric(Number(value));
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return failure();
      const number = Number(value);
      return Number.isFinite(number) ? numeric(number) : failure();
    }
    if (rule.type === 'guid') {
      if (typeof value !== 'string') return failure();
      try { return nativeGuid(value).replaceAll('-','').toLowerCase(); }
      catch {
        const error = new BindingError('','The supplied value is invalid.');
        Object.assign(error,{nativeException:'FormatException',nativeMessage:'Unrecognized Guid format.'});
        throw error;
      }
    }
    if (rule.type === 'enum') {
      let number;
      if (typeof value === 'string') {
        const text = clrTrim(value);
        if (/^[+-]?\d+$/.test(text)) number = Number(text);
        else {
          number = 0;
          for (const part of text.split(',')) {
            const pair = Object.entries(rule.values).find(([name])=>ordinalIgnoreCaseEquals(name, clrTrim(part)));
            if (!pair) return failure();
            number |= pair[1];
          }
        }
      } else if (typeof value === 'number' && /^-?\d+$/.test(source.slice(node.start,node.end))) number = value;
      if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) return failure();
      return Object.entries(rule.values).find(([,entry])=>entry===number)?.[0] ?? number;
    }
    if (rule.type === 'array') {
      if (node.items) return node.items.map((item,index) => convert(item, rule.item,
        rule.converterArrayRoot ? `$[${index}]` : `${path}[${index}]`, rule.converterArrayRoot ? node.start : baseOffset));
      if (rule.delimiter && typeof value === 'string' && rule.item.type === 'enum') {
        const result = [];
        for (const part of value.split(rule.delimiter).filter(Boolean)) {
          const text = clrTrim(part);
          let numeric;
          if (/^[+-]?\d+$/.test(text)) numeric = Number(text);
          else numeric = Object.entries(rule.item.values).find(([name]) => ordinalIgnoreCaseEquals(name, text))?.[1];
          if (!Number.isInteger(numeric) || numeric < -2147483648 || numeric > 2147483647) continue;
          result.push(Object.entries(rule.item.values).find(([,entry]) => entry === numeric)?.[0] ?? numeric);
        }
        return result;
      }
      if (rule.delimiter && typeof value === 'string' && ['guid', 'string'].includes(rule.item.type)) {
        return value.split(rule.delimiter).filter(Boolean).flatMap(part => {
          const text = clrTrim(part);
          if (rule.item.type === 'string') return [text];
          try { return [nativeGuid(text).replaceAll('-', '').toLowerCase()]; }
          catch { return []; }
        });
      }
      return failure();
    }
    if (rule.type === 'dictionary') {
      if (!node.properties) return failure();
      return new Map(node.properties.map(([key, item, keySpan]) => [
        !key.isWellFormed() ? convert({ value: key, start: keySpan.start, end: keySpan.end },
          { type: 'string', clrType: 'System.String', nullable: false }, path, baseOffset) :
        rule.key && rule.key.type !== 'string' ? convert({ value: key, start: item.start, end: item.start }, rule.key, `${path}.${key}`, baseOffset) : key,
        convert(item, rule.item, `${path}.${key}`, baseOffset)
      ]));
    }
    if (rule.type === 'object') {
      if (!node.properties) return failure();
      const definition = schema.definitions[rule.reference];
      const result = structuredClone(definition.defaults);
      const emptyGuidFields = new Set();
      const present = new Set();
      for (const [key,nodeValue,keySpan] of node.properties) {
        if (!key.isWellFormed()) return failure(undefined, keySpan.end);
        const name = Object.keys(definition.fields).find(name => caseInsensitiveProperties ? ordinalIgnoreCaseEquals(name, key) : name === key);
        if (name) {
          present.add(name);
          result[name] = convert(nodeValue,definition.fields[name],`${path}.${key}`,baseOffset);
          emptyGuidFields.delete(name);
          if (definition.fields[name].type === 'guid' && !definition.fields[name].preserveEmptyGuid && result[name] === '00000000000000000000000000000000') {
            result[name] = null;
            emptyGuidFields.add(name);
          }
        }
      }
      const missing = (definition.jsonRequired ?? []).filter(name => !present.has(name));
      if (missing.length) throw new BindingError(path, `JSON deserialization for type '${rule.clrType}' was missing required properties including: ${missing.map(name => `'${name}'`).join(', ')}.`);
      return emptyGuidFields.size ? withNativeNulls(result,emptyGuidFields) : result;
    }
    throw new TypeError(`Unsupported model property type: ${rule.type}`);
  }
  return convert(tokenizeJson(source),root,'$');
}

// ASP.NET validates non-nullable references after deserialization succeeds.
export function validateJsonModel(value, { schema, root, path = '' }) {
  const errors = {};
  function visit(value, rule, path) {
    if (value == null) return;
    if (rule.type === 'array') return value.forEach((item,index) => visit(item,rule.item,`${path}[${index}]`));
    if (rule.type !== 'object') return;
    const definition = schema.definitions[rule.reference];
    for (const [name,field] of Object.entries(definition.fields)) {
      const fieldPath = path ? `${path}.${name}` : name;
      if (value[name] == null && definition.required?.includes(name)) errors[fieldPath] = [`The ${name} field is required.`];
      else if (typeof value[name] === 'string' && clrTrim(value[name]) === '' && definition.nonEmpty?.includes(name)) errors[fieldPath] = [`The ${name} field is required.`];
      else visit(value[name],field,fieldPath);
    }
  }
  visit(value,root,path);
  if (Object.keys(errors).length) {
    const error = new BindingError('', 'One or more validation errors occurred.');
    error.errors = errors;
    throw error;
  }
  return value;
}
