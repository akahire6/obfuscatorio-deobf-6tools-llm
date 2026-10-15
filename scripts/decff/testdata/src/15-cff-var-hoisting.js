// var 巻き上げ依存。平坦化されたケースは実行順が並べ替えられるので、
// 解除時に「親ブロックへ直接展開」しないと壊れる。
// typeof で未初期化の var を先に読み、巻き上げの挙動そのものを出力に出す。
var hoisted = function (n) {
  var seenBefore = typeof later;
  var first = n * 2;
  var second = first + 3;
  var third = second * 2;
  var label = 'h' + n;
  var later = 'assigned';
  var seenAfter = typeof later;
  return label + ' ' + seenBefore + '->' + seenAfter + ' ' + first + '/' + second + '/' + third;
};

var crossRef = function (n) {
  var a = n + 1;
  var b = a * 2;
  var c = b + a;
  var d = c - n;
  var e = d * 3;
  var f = e + b;
  return [a, b, c, d, e, f].join('-');
};

console.log(hoisted(4));
console.log(hoisted(9));
console.log(crossRef(5));
console.log(crossRef(12));
