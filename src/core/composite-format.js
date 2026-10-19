// Server messages use indexed placeholders without format specifiers.
export function compositeFields(template) {
  const fields=[];
  for (let index=0;index<template.length;) {
    const character=template[index++];
    if (character!=='{' && character!=='}') continue;
    if (template[index]===character) { index++; continue; }
    if (character==='}') throw new TypeError('Unexpected closing format brace.');
    const match=/^(\d+)(?:\s*,\s*(-?\d+))?\s*}/.exec(template.slice(index));
    if (!match) throw new TypeError('Unsupported or invalid composite format.');
    fields.push(Number(match[1]));
    index+=match[0].length;
  }
  return fields;
}

export function formatComposite(template,values) {
  compositeFields(template);
  let result='';
  for (let index=0;index<template.length;) {
    const character=template[index++];
    if (character!=='{' && character!=='}') { result+=character; continue; }
    if (template[index]===character) { result+=character; index++; continue; }
    const match=/^(\d+)(?:\s*,\s*(-?\d+))?\s*}/.exec(template.slice(index));
    const argument=Number(match[1]);
    if (argument>=values.length) throw new RangeError('Composite format argument is missing.');
    const value=values[argument];
    if (value instanceof Date || (value!==null && typeof value==='object')) throw new TypeError('Format domain values explicitly before interpolation.');
    const text=value==null?'':typeof value==='boolean'?(value?'True':'False'):String(value);
    const width=Number(match[2]??0);
    if (!Number.isSafeInteger(width) || Math.abs(width)>1000000) throw new RangeError('Invalid composite alignment.');
    result+=width<0?text.padEnd(-width):text.padStart(width);
    index+=match[0].length;
  }
  return result;
}
