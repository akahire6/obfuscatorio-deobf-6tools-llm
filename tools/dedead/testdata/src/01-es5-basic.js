// ES5 のみ（var / function 宣言）。stdin を読んで行ごとに集計する。
var lines = require('fs').readFileSync('/dev/stdin', 'utf8').trim().split('\n');

function wordCount(line) {
  var parts = line.split(' ');
  var total = 0;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].length > 0) {
      total += 1;
    }
  }
  return total;
}

function describe(n) {
  if (n === 0) {
    return 'empty';
  } else if (n === 1) {
    return 'single';
  }
  return 'multi(' + n + ')';
}

var out = [];
for (var j = 0; j < lines.length; j++) {
  var n = wordCount(lines[j]);
  out.push(describe(n) + ' ' + lines[j].toUpperCase());
}
console.log(out.join('\n'));
