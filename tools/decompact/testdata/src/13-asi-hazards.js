// 自動セミコロン挿入の罠。改行の入り方が変われば意味が変わってしまう形を集めた。
// escodegen が括弧・セミコロン・改行位置を正しく置けているかを、実行結果の一致で見る。

function tag(strings, value) {
  return strings.raw[0] + '|' + value;
}

function makePair(a, b) {
  return {
    left: a,
    right: b
  };
}

function earlyReturn(flag) {
  if (!flag) return;
  return 'ok';
}

var counter = 0;
var arr = [1, 2, 3];

// 次行が [ で始まる: ASI は起きず arr への添字にならないよう ; が要る
counter++
;[4, 5].forEach(function (n) { arr.push(n); })

// ここは ASI が起きる: x = counter で文が切れ、次行は前置インクリメント
var x = counter
++counter

// ここは ASI が起きない: 直前の式の呼び出しになる（y は 1 になる）
var y = (function () { return 1; })
(function () {})

// 次行が ( で始まる: ; が無いと直前の配列が呼び出される
var parts = ['a', 'b']
;(function () { parts.push('c'); })()

// タグ付きテンプレート。改行を挟んでもタグ呼び出しのまま
var tpl = tag
`tagless${counter}`

console.log(JSON.stringify(makePair(1, 2)));
console.log(earlyReturn(false), earlyReturn(true));
console.log(arr.join(','), x, counter, y, parts.join(''), tpl);
