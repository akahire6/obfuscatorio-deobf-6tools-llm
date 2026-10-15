// ユーザー由来の break / continue を消さないこと。
// obfuscator.io は while の内側を VisitorOption.Skip で見ないので、
// 5 文以上のブロックの中に while を置いて break / continue を使っても平坦化される。
var scan = function (arr) {
  var hits = [];
  var skipped = 0;
  var i = 0;
  var limit = arr.length;
  var label = 'scan';
  while (i < limit) {
    if (arr[i] < 0) {
      skipped += 1;
      i += 1;
      continue;
    }
    if (arr[i] > 90) {
      break;
    }
    hits.push(arr[i]);
    i += 1;
  }
  return label + ' hits=' + hits.join(',') + ' skipped=' + skipped + ' stop=' + i;
};

console.log(scan([1, -2, 3, -4, 5]));
console.log(scan([10, 20, 95, 30]));
console.log(scan([-1, -2, -3]));
