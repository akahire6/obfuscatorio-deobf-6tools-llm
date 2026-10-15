// 多重ネスト関数とクロージャ（ラッパー別名が多段になる形）
function outer(prefix) {
  const tag = prefix + '::';
  return function middle(mid) {
    const joined = tag + mid + '/';
    return function inner(leaf) {
      function deepest(extra) {
        return joined + leaf + '#' + extra;
      }
      return deepest('end');
    };
  };
}

const build = outer('root');
console.log(build('one')('leafA'));
console.log(build('two')('leafB'));

const counter = (function () {
  let n = 0;
  return {
    bump: function () {
      n += 1;
      return 'count=' + n;
    },
    reset: function () {
      n = 0;
      return 'reset';
    }
  };
})();

console.log(counter.bump());
console.log(counter.bump());
console.log(counter.reset());
console.log(counter.bump());
