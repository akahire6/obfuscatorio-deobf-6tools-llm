// debug-protection の本体に構造だけ似せた「偽 DPF」。
// 引数 1 個の関数の中に自己再帰する内側関数があり、空の catch を持つ。
// 構造マッチだけで判定すると誤爆する形なので、文字列条件が効いていることの検査になる。
function lookalike(ret) {
  function walker(counter) {
    if (typeof counter === 'string') {
      return String(counter).length;
    }
    if (counter > 4) {
      return counter;
    }
    walker(++counter);
  }
  try {
    if (ret) {
      return walker;
    } else {
      walker(0);
    }
  } catch (y) {
  }
}

console.log(typeof lookalike('init'));
console.log(lookalike());
