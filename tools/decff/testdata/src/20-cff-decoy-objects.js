// ★ 誤検出の負例。CFF の storage 辞書に似た形のオブジェクトをユーザーコードとして書き、
// 検出条件で弾かれることを確かめる。
//
// ★ 注意: 「5 文字キーだけ・全プロパティが転送関数か難読化器由来の定数・定数キーでしか
//   参照されない」を完全に満たすオブジェクトは、ユーザーが書いても CFF の storage と
//   構造上まったく区別できない。ここではそこまで似せず、現実のコードにありがちな形で
//   条件のどれかを外したものを並べる。
var byMultiStatement = function (n) {
  // 関数本体が 2 文以上ある → 転送関数ではない
  var tbl = {
    'aaaaa': function (a, b) {
      var s = a + b;
      return s * 2;
    },
    'bbbbb': function (a, b) {
      return a - b;
    }
  };
  var x = tbl['aaaaa'](n, 3);
  var y = tbl['bbbbb'](n, 1);
  var z = x + y;
  var tag = 'multi';
  return tag + ' ' + x + ' ' + y + ' ' + z;
};

var byPassedAround = function (n) {
  // 辞書そのものを値として渡す / キーを列挙する → 定数キーのメンバ読みだけ、ではない
  var dict = { 'ccccc': function (a, b) { return a + b; }, 'ddddd': function (a, b) { return a * b; } };
  var use = function (d, a, b) {
    return d['ccccc'](a, b) + d['ddddd'](a, b);
  };
  var keys = Object.keys(dict).sort().join(',');
  var total = use(dict, n, 2);
  var tag = 'passed';
  return tag + ' ' + keys + ' ' + total;
};

var byDynamicKey = function (n) {
  // キーを実行時に組み立てて引く → 定数キーではない
  var ops = { 'eeeee': function (a, b) { return a + b; }, 'fffff': function (a, b) { return a - b; } };
  var names = ['eeeee', 'fffff'];
  var pick = names[n % 2];
  var got = ops[pick](n, 4);
  var other = ops['eeeee'](n, 1);
  var tag = 'dynamic';
  return tag + ' ' + pick + ' ' + got + ' ' + other;
};

var byLongKeys = function (n) {
  // キーが 5 文字でない → CFF の storage の形ではない
  var handlers = { 'plusOne': function (a, b) { return a + b; }, 'timesTwo': function (a, b) { return a * b; } };
  var a = handlers['plusOne'](n, 1);
  var b = handlers['timesTwo'](n, 2);
  var c = a + b;
  var tag = 'longkeys';
  return tag + ' ' + a + ' ' + b + ' ' + c;
};

var byReassigned = function (n) {
  // 再代入される → binding.constant でない
  var table = { 'ggggg': function (a, b) { return a + b; } };
  var first = table['ggggg'](n, 1);
  table = { 'ggggg': function (a, b) { return a * b; } };
  var second = table['ggggg'](n, 3);
  var tag = 'reassigned';
  return tag + ' ' + first + ' ' + second;
};

console.log(byMultiStatement(5));
console.log(byPassedAround(6));
console.log(byDynamicKey(7));
console.log(byDynamicKey(8));
console.log(byLongKeys(9));
console.log(byReassigned(4));
