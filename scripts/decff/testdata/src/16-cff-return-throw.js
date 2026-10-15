// 非 continue 終端。順序の途中に return が来る形、try/catch の両腕が 5 文以上、
// throw を経由する分岐。ケース本体の終端が continue だけではないことを当てる。
var earlyReturn = function (n) {
  var a = n + 1;
  var b = a * 2;
  var c = b + 3;
  var d = c * 4;
  var e = d - 5;
  if (n < 0) {
    return 'neg:' + a;
  }
  return [a, b, c, d, e].join('.');
};

var risky = function (n) {
  var out = '';
  try {
    var a = n * 2;
    var b = a + 1;
    var c = b * 3;
    var d = c - 4;
    var e = d + 5;
    if (e > 40) {
      throw new Error('too big ' + e);
    }
    out = 'ok:' + [a, b, c, d, e].join(',');
  } catch (err) {
    var m = err.message;
    var len = m.length;
    var up = m.toUpperCase();
    var head = up.slice(0, 3);
    var tail = up.slice(-3);
    out = 'err:' + len + ':' + head + ':' + tail;
  }
  return out;
};

console.log(earlyReturn(3));
console.log(earlyReturn(-2));
console.log(risky(2));
console.log(risky(9));
