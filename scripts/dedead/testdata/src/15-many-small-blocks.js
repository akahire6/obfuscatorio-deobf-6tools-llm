// 小さなブロックを数多く持つプログラム。
// deadCodeInjection は収集したブロックが 5 個未満だと発火しないので、
// 注入密度を上げて「入れ子になった deadcode」を当てやすくする。
// switch の case / for 本体 / try-catch / class メソッド / getter を一通り並べる。

class Counter {
  constructor(start) {
    this.value = start;
  }
  bump(delta) {
    this.value += delta;
    return this.value;
  }
  get doubled() {
    const d = this.value * 2;
    return d;
  }
  static describe(n) {
    if (n > 10) {
      return 'big';
    } else {
      return 'small';
    }
  }
}

function classify(n) {
  switch (n % 4) {
    case 0: {
      const tag = 'zero';
      return tag;
    }
    case 1: {
      const tag = 'one';
      return tag;
    }
    case 2: {
      const tag = 'two';
      return tag;
    }
    default: {
      const tag = 'three';
      return tag;
    }
  }
}

function guarded(list) {
  const out = [];
  for (const item of list) {
    try {
      if (item < 0) {
        throw new RangeError('negative');
      } else {
        out.push(classify(item));
      }
    } catch (err) {
      out.push('err:' + err.name);
    }
  }
  return out;
}

function accumulate(n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      total += i;
    } else {
      total -= 1;
    }
  }
  return total;
}

const c = new Counter(3);
console.log(c.bump(4), c.doubled, Counter.describe(c.value));
console.log(guarded([0, 1, -2, 3, 6]).join(','));
console.log(accumulate(12));
