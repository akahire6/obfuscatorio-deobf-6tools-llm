// 再帰と try / catch / throw
class ParseError extends Error {
  constructor(msg, pos) {
    super(msg);
    this.name = 'ParseError';
    this.pos = pos;
  }
}

function depth(node, level) {
  if (level > 6) {
    throw new ParseError('too deep', level);
  }
  if (!node.children || node.children.length === 0) {
    return level;
  }
  return Math.max.apply(null, node.children.map(c => depth(c, level + 1)));
}

function nest(n) {
  return n === 0 ? { children: [] } : { children: [nest(n - 1)] };
}

for (const n of [1, 3, 5, 9]) {
  try {
    console.log('depth(' + n + ') = ' + depth(nest(n), 0));
  } catch (e) {
    if (e instanceof ParseError) {
      console.log('caught ' + e.name + ' at ' + e.pos + ': ' + e.message);
    } else {
      throw e;
    }
  } finally {
    console.log('-- done ' + n);
  }
}
