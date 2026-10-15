// 関数本体の先頭に directive があるプログラム。
// deadcode-injection は関数本体の BlockStatement も置換対象にするので、
//   function f(){'use strict'; ..}  ->  function f(){if(P){'use strict'; ..}else{..}}
// になり得る。この時点で 'use strict' はもう directive ではない。
// 解除でブロックを外して関数本体の先頭へ戻すと strict モードが復活し、
// 意味が変わる（下の sloppy な代入が TypeError になる）。その回帰テスト。

function strictAdder(a, b) {
  'use strict';
  let total = 0;
  total += a;
  total += b;
  return total;
}

function sloppyWriter() {
  // strict でないので、凍結されたオブジェクトへの代入が黙って無視される。
  // strict が復活すると TypeError になるので、層の剥がし方の誤りを検出できる。
  const frozen = Object.freeze({ value: 1 });
  frozen.value = 2;
  return frozen.value;
}

function nestedDirective() {
  'use strict';
  function inner() {
    'use strict';
    let acc = 0;
    for (let i = 0; i < 5; i++) {
      acc += i;
    }
    return acc;
  }
  return inner() + 1;
}

console.log(strictAdder(3, 4));
console.log(sloppyWriter());
console.log(nestedDirective());
