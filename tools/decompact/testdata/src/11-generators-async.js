// ジェネレータ / async-await / Symbol / getter-setter
const KEY = Symbol('secret');

class Box {
  constructor(v) {
    this[KEY] = v;
  }
  get value() {
    return this[KEY];
  }
  set value(v) {
    this[KEY] = 'set:' + v;
  }
  *[Symbol.iterator]() {
    yield 'a';
    yield 'b';
    yield this.value;
  }
}

function* range(start, stop) {
  for (let i = start; i < stop; i++) {
    yield i * i;
  }
}

async function main() {
  const b = new Box('init');
  console.log(b.value);
  b.value = 'x';
  console.log(b.value);
  console.log([...b].join('/'));
  console.log([...range(1, 6)].join(','));

  const got = await Promise.all([Promise.resolve('first'), new Promise(res => setTimeout(() => res('second'), 1))]);
  console.log(got.join(' then '));
}

main();
