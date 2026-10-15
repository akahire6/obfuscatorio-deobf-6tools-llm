// 引数の副作用と評価順序。CFF は二項演算や呼び出しを辞書経由の間接呼び出しに
// 置き換えるので、インライン展開で評価順が入れ替わると出力が変わる。
// 評価の跡が stdout に出るように書いて、順序保存を挙動で検証する。
var trace = [];
var note = function (tag, value) {
  trace.push(tag);
  return value;
};

var orderSensitive = function () {
  var i = 0;
  var arr = [10, 20, 30, 40];
  var x = arr[i++];
  var y = arr[i++];
  var z = note('A', 1) + note('B', 2) + note('C', 3);
  var w = note('D', 4) * note('E', 5);
  var s = '' + note('F', 'f') + note('G', 'g');
  return [x, y, z, w, s, i].join('|');
};

var mixed = function (n) {
  var c = 0;
  var bump = function () {
    c += 1;
    return c;
  };
  var a = bump() + bump();
  var b = bump() * bump();
  var d = a - b;
  var e = d + bump();
  var f = '' + a + b + d + e;
  return f + ' c=' + c + ' n=' + n;
};

console.log(orderSensitive());
console.log(trace.join(''));
console.log(mixed(1));
console.log(mixed(2));
