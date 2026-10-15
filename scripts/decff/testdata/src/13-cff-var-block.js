// 基本のディスパッチャ。1 ブロック 5 文以上・var のみ・関数宣言なしで、
// obfuscator.io の BlockStatementControlFlowTransformer を確実に発火させる。
var wordStats = function (text) {
  var words = text.split(' ');
  var total = words.length;
  var longest = '';
  var sum = 0;
  var i = 0;
  var acc = [];
  while (i < total) {
    sum += words[i].length;
    if (words[i].length > longest.length) {
      longest = words[i];
    }
    acc.push(words[i].toUpperCase());
    i += 1;
  }
  return total + ':' + sum + ':' + longest + ':' + acc.join(',');
};

var buildReport = function (rows) {
  var head = 'REPORT';
  var body = rows.join('|');
  var count = rows.length;
  var width = body.length;
  var tag = count > 2 ? 'big' : 'small';
  var stamp = head + '-' + tag;
  return stamp + '/' + count + '/' + width + '/' + body;
};

var classify = function (n) {
  var even = n % 2 === 0;
  var big = n > 100;
  var name = 'n' + n;
  var score = n * 3 + 1;
  var label = even ? 'even' : 'odd';
  var extra = big ? 'big' : 'small';
  return name + ' ' + label + ' ' + extra + ' ' + score;
};

console.log(wordStats('alpha beta gammaa delta'));
console.log(buildReport(['a', 'bb', 'ccc']));
console.log(classify(7));
console.log(classify(240));
