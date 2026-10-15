// this バインディングの罠。CFF の辞書は f(a,b) 形の呼び出しを
// DICT['K'](f, a, b) に置き換える。これを素朴に展開すると
// DICT['K'](obj.m, x) -> obj.m(x) となり this が undefined から obj に変わる。
// 展開してよい形と、してはいけない形の両方を挙動で確かめる。
var counter = {
  n: 100,
  bump: function (d) {
    this.n += d;
    return this.n;
  },
  name: function () {
    return this === counter ? 'self' : 'detached';
  }
};

var run = function () {
  var a = counter.bump(1);
  var b = counter.bump(2);
  var m = counter.name;
  var c = counter.name();
  var d = a + b;
  var e = 'n=' + counter.n;
  return [a, b, c, d, e].join('/');
};

var apply1 = function (fn, arg) {
  var pre = 'call';
  var out = fn(arg);
  var post = 'done';
  var len = ('' + out).length;
  var tag = pre + '-' + post;
  return tag + ':' + out + ':' + len;
};

var double = function (x) {
  return x * 2;
};

console.log(run());
console.log(apply1(double, 21));
console.log(apply1(String, 7));
