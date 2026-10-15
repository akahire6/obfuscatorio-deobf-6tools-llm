// 整形で壊れやすい構文の隅。ラベル・do-while・カンマ演算子・for(in) の曖昧性・
// getter/setter・debugger・正規表現と除算の見分けを 1 本に詰めた。

var box = {
  _v: 1,
  get v() { return this._v; },
  set v(n) { this._v = n * 2; },
  'quoted-key': 'q',
  0: 'zero'
};

var found = [];

outer:
for (var i = 0; i < 4; i++) {
  inner:
  for (var j = 0; j < 4; j++) {
    if (j === 2) continue outer;
    if (i === 3) break outer;
    found.push(i + ':' + j);
  }
}

var n = 0;
do {
  n += 1;
} while (n < 3);

// カンマ演算子（括弧が落ちると意味が変わる）
var c = (n += 1, n * 10);

// for の初期化節の in は括弧で包まないと for-in と区別できない
var hasV = false;
for (var k = ('v' in box); k && !hasV; k = false) {
  hasV = true;
}

// 正規表現リテラルと除算の見分け
var re = /a+\/b/g;
var div = c / 2 / 2;

debugger;

var labelled = 0;
block: {
  labelled = 1;
  if (labelled) break block;
  labelled = 99;
}

box.v = 5;

console.log(found.join(' '));
console.log(n, c, hasV, re.test('aa/b'), div, labelled);
console.log(box.v, box['quoted-key'], box[0]);
