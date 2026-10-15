// 入れ子のディスパッチャ。関数本体も、その中の if ブロックも 5 文以上にして
// 二重に平坦化させる。解除側の不動点反復が効いているかを見る。
var process1 = function (n) {
  var base = n + 1;
  var doubled = base * 2;
  var name = 'v' + n;
  var flag = n % 3 === 0;
  var out = '';
  if (flag) {
    var a = base + 10;
    var b = doubled + 20;
    var c = a + b;
    var d = c * 2;
    var e = 'yes';
    out = e + ':' + a + ':' + b + ':' + c + ':' + d;
  } else {
    var p = base - 1;
    var q = doubled - 2;
    var r = p + q;
    var s = r * 3;
    var u = 'no';
    out = u + ':' + p + ':' + q + ':' + r + ':' + s;
  }
  return name + '=' + out;
};

var i = 0;
while (i < 6) {
  console.log(process1(i));
  i += 1;
}
