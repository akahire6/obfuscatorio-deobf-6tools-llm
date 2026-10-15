// 改行を含むリテラル。整形しても中身が 1 バイトも変わってはいけない。
// テンプレートリテラル・行継続・エスケープ・タグ付きテンプレートの raw を見る。

var block = `line1
line2	tabbed
line3`;

var cont = 'a\
b';

var escaped = 'tab:\t nl:\n cr:\r quote:\' back:\\ hex:\x41 uni:B null:\0end';

function raw(strings) {
  return strings.raw.join('#');
}
var rawed = raw`r1\n
r2`;

var nested = `outer ${`inner
${1 + 1}`} done`;

var re = new RegExp('^\\s+$', 'm');

console.log(JSON.stringify(block));
console.log(JSON.stringify(cont));
console.log(JSON.stringify(escaped));
console.log(JSON.stringify(rawed));
console.log(JSON.stringify(nested));
console.log(re.test(' \n'), block.split('\n').length);
