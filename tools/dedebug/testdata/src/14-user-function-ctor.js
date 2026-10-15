// ユーザが正当に Function コンストラクタを使うプログラム。
// スパイ（spy-preload.js）が debugger 生成と取り違えないことの検査。
var add = new Function('a', 'b', 'return a + b;');
var greet = Function('name', 'return "hi " + name;');

console.log(add(2, 3));
console.log(greet('world'));
console.log(typeof Function('return 1')());
