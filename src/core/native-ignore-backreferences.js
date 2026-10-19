// CLR backreferences fail when their capture has not participated. ECMAScript
// accepts an unmatched reference as empty, so reference patterns need a matcher.
export function compileNativeBackreferences(source) {
  let index = 0, capture = 0;
  const atomic = text => ({ kind: 'atom', expression: new RegExp(text, 'y') });
  const groupEnd = start => {
    let depth = 0, inClass = false;
    for (let end = start; end < source.length; end++) {
      const char = source[end];
      if (char === '\\') { end++; continue; }
      if (char === '[') inClass = true;
      if (char === ']') inClass = false;
      if (inClass) continue;
      if (char === '(') depth++;
      if (char === ')' && --depth === 0) return end + 1;
    }
    throw new SyntaxError('Unterminated native reference group.');
  };
  const expression = () => {
    const branches = [];
    do {
      const children = [];
      while (index < source.length && ![')', '|'].includes(source[index])) {
        let node;
        const start = index, char = source[index++];
        if (char === '(' && source[index] === '?') {
          index = groupEnd(start); node = atomic(source.slice(start, index));
        } else if (char === '(') {
          const id = ++capture, child = expression();
          if (source[index++] !== ')') throw new SyntaxError('Unterminated native capture.');
          node = { kind: 'capture', id, child };
        } else if (char === '[') {
          while (index < source.length) {
            const next = source[index++];
            if (next === '\\') index++;
            else if (next === ']') break;
          }
          node = atomic(source.slice(start, index));
        } else if (char === '\\') {
          if (/[0-9]/.test(source[index] ?? '')) {
            const first = index; while (/[0-9]/.test(source[index] ?? '')) index++;
            node = { kind: 'reference', id: Number(source.slice(first, index)) };
          } else {
            const escaped = source[index++];
            if (escaped === 'u') index += 4;
            else if (escaped === 'x') index += 2;
            node = atomic(source.slice(start, index));
          }
        } else node = atomic(source.slice(start, index));
        const quantifier = source[index];
        let min, max;
        if (['*', '+', '?'].includes(quantifier)) {
          index++; min = quantifier === '+' ? 1 : 0; max = quantifier === '?' ? 1 : Infinity;
        } else if (quantifier === '{') {
          const bounds = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(index));
          if (bounds) {
            index += bounds[0].length; min = Number(bounds[1]);
            max = bounds[2] === undefined ? min : bounds[2] === '' ? Infinity : Number(bounds[2]);
          }
        }
        if (min !== undefined) {
          const lazy = source[index] === '?'; if (lazy) index++;
          node = { kind: 'repeat', child: node, min, max, lazy };
        }
        children.push(node);
      }
      branches.push({ kind: 'sequence', children });
      if (source[index] !== '|') break;
      index++;
    } while (true);
    return branches.length === 1 ? branches[0] : { kind: 'alternative', branches };
  };
  const tree = expression();
  if (index !== source.length) throw new SyntaxError('Invalid native reference expression.');
  // Validate the complete expression, including quantifier limits and anchors.
  new RegExp(source);
  function* match(node, state, value) {
    switch (node.kind) {
      case 'atom': {
        node.expression.lastIndex = state.position;
        const found = node.expression.exec(value);
        if (found) yield { ...state, position: node.expression.lastIndex };
        return;
      }
      case 'reference': {
        const text = state.captures[node.id];
        if (text !== undefined && value.startsWith(text, state.position)) yield { ...state, position: state.position + text.length };
        return;
      }
      case 'capture': {
        for (const found of match(node.child, state, value)) {
          const captures = found.captures.slice(); captures[node.id] = value.slice(state.position, found.position);
          yield { ...found, captures };
        }
        return;
      }
      case 'alternative': {
        for (const branch of node.branches) yield* match(branch, state, value);
        return;
      }
      case 'sequence': {
        function* next(offset, current) {
          if (offset === node.children.length) { yield current; return; }
          for (const found of match(node.children[offset], current, value)) yield* next(offset + 1, found);
        }
        yield* next(0, state); return;
      }
      case 'repeat': {
        function* repeat(count, current) {
          if (node.lazy && count >= node.min) yield current;
          if (count < node.max) for (const found of match(node.child, current, value)) {
            if (found.position !== current.position || count + 1 < node.min) yield* repeat(count + 1, found);
            else if (count + 1 >= node.min) yield found;
          }
          if (!node.lazy && count >= node.min) yield current;
        }
        yield* repeat(0, state); return;
      }
      default: throw new Error('Unknown native reference node.');
    }
  }
  return { test(value) {
    for (let position = 0; position <= value.length; position++) {
      for (const found of match(tree, { position, captures: [] }, value)) { void found; return true; }
    }
    return false;
  } };
}
