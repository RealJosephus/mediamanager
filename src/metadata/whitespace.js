export const clrWhitespace = '\\u0009-\\u000d\\u0085\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
export const clrWhitespaceCharacters = '\u0009\u000a\u000b\u000c\u000d\u0085\u0020\u00a0\u1680'
  + '\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a'
  + '\u2028\u2029\u202f\u205f\u3000';
export const ecmaWhitespaceCharacters = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680'
  + '\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a'
  + '\u2028\u2029\u202f\u205f\u3000\ufeff';
const leadingOrTrailing = new RegExp(`^[${clrWhitespace}]+|[${clrWhitespace}]+$`, 'gu');
const leading = new RegExp(`^[${clrWhitespace}]+`, 'u');
const trailing = new RegExp(`[${clrWhitespace}]+$`, 'u');
export const clrTrim = value => value.replace(leadingOrTrailing, '');
export const clrTrimStart = value => value.replace(leading, '');
export const clrTrimEnd = value => value.replace(trailing, '');
