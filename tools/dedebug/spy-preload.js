#!/usr/bin/env node
'use strict';

/**
 * spy-preload.js — debugger 生成の動的検出。
 *
 * node -r ./spy-preload.js target.js  の形で本体より先に読み込ませる。
 *
 * debug-protection は fn['constructor']('debu' + 'gger') で debugger 文を持つ関数を
 * 動的に作る。fn.constructor はプロトタイプチェーンをたどって
 * Function.prototype.constructor に届くので、そこを差し替えれば
 * 「debugger を作ろうとしたか」をすべて捕捉できる。
 * グローバル束縛の Function には触らない（interval 版が
 * Function('return (function(){}.constructor("return this")())') を使うため）。
 *
 * スパイは無害な空関数を返す:
 *   - debugger        … 素の node では inspector 未接続なら no-op なので意味論は変わらない
 *   - while (true) {} … 改竄検知が発火したときの罠。生で通すとハングするので必ず潰す
 *                       （wt > 0 は「壊した」ことのシグナルになる）
 *
 * setInterval は unref() して、解除し損ねた interval 版がプロセスを掴んだままに
 * なるのを防ぐ。
 *
 * 集計は終了時に stderr へ 1 行のマーカとして出す。stdout は汚さない。
 */

const OrigFunction = Function;
let dbg = 0;
let wt = 0;
let iv = 0;

const NOOP = function () {};

function Spy() {
  const args = Array.prototype.slice.call(arguments);
  const body = args.length ? String(args[args.length - 1]) : '';
  if (/\bdebugger\b/.test(body)) {
    dbg += 1;
    return NOOP;
  }
  if (/while\s*\(\s*true\s*\)/.test(body)) {
    wt += 1;
    return NOOP;
  }
  return OrigFunction.apply(null, args);
}
Spy.prototype = Function.prototype;

Object.defineProperty(Function.prototype, 'constructor', {
  value: Spy,
  writable: true,
  configurable: true
});

const origSetInterval = global.setInterval;
global.setInterval = function () {
  iv += 1;
  const handle = origSetInterval.apply(this, arguments);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
};

process.on('exit', () => {
  try {
    process.stderr.write('__DEDEBUG_SPY__' + JSON.stringify({ dbg, wt, iv }) + '\n');
  } catch (_) {
    /* stderr が閉じていても本体の結果には影響しない */
  }
});
