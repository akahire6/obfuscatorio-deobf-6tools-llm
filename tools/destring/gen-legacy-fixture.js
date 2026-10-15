#!/usr/bin/env node
'use strict';

/**
 * gen-legacy-fixture.js — 旧世代デコーダ形式のフィクスチャを自前で組み立てる。
 *
 * javascript-obfuscator 5.x のデコーダは素直な形だが、4.x 系は
 * 「最初の呼び出しで自分自身を書き換える」形を出す:
 *
 *   function D(a, b){
 *     var arr = SA();
 *     D = function(x, y){ x = x - OFFSET; var v = arr[x]; return v; };
 *     return D(a, b);
 *   }
 *
 * 手元の javascript-obfuscator では旧形式を生成できないので、同じ形を
 * **ここで一から組み立てる**（データセットからの流用はしない）。
 * ローテータの検査和も実際に成立する値を計算して埋めるので、
 * 「回転してからでないと正しい文字列が引けない」という本質もそのまま再現される。
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'testdata', 'obf', 'legacy');

const OFFSET = 0x1a4;
const ROTATIONS = 5; // ローテータが arr.push(arr.shift()) を回す回数

// デコーダから見えるべき最終的な配列（回転が終わった後の並び）
const FINAL = [
  'hello',
  'log',
  'world',
  ' ',
  'join',
  '-',
  'toUpperCase',
  '42aaaa', // 以下 3 つは検査和専用（ローテータごと消えるのが正しい）
  '84bbbb',
  '126cccc'
];

const idx = (s) => FINAL.indexOf(s) + OFFSET;

/** arr.push(arr.shift()) を k 回回すと FINAL になるような初期配列 = FINAL を右に k 回転 */
function rotateRight(arr, k) {
  const n = arr.length;
  const shift = ((k % n) + n) % n;
  return arr.slice(n - shift).concat(arr.slice(0, n - shift));
}

const SOURCE_ARRAY = rotateRight(FINAL, ROTATIONS);

// 検査和: parseInt('42aaaa')/1 + parseInt('84bbbb')/2 + parseInt('126cccc')/3 = 42+42+42 = 126
const CHECKSUM = 42 / 1 + 84 / 2 + 126 / 3;

const q = (s) => JSON.stringify(s);
const hex = (n) => '0x' + n.toString(16);

const code = `var a0_0xtop=a0_0xdec;(function(_0xf1,_0xf2){var _0xw=a0_0xdec;var _0xarr=_0xf1();while(!![]){try{var _0xsum=parseInt(_0xw(${hex(
  idx('42aaaa')
)}))/0x1+parseInt(_0xw(${hex(idx('84bbbb'))}))/0x2+parseInt(_0xw(${hex(
  idx('126cccc')
)}))/0x3;if(_0xsum===_0xf2){break;}else{_0xarr['push'](_0xarr['shift']());}}catch(_0xe){_0xarr['push'](_0xarr['shift']());}}}(a0_0xarr,${CHECKSUM}));\
function a0_0xarr(){var _0xdata=[${SOURCE_ARRAY.map(q).join(',')}];a0_0xarr=function(){return _0xdata;};return a0_0xarr();}\
function a0_0xdec(_0xa,_0xb){var _0xlist=a0_0xarr();a0_0xdec=function(_0xx,_0xy){_0xx=_0xx-${hex(
  OFFSET
)};var _0xv=_0xlist[_0xx];return _0xv;};return a0_0xdec(_0xa,_0xb);}\
function main(){var _0xw=a0_0xtop;var _0xg=_0xw(${hex(idx('hello'))});var _0xt=_0xw(${hex(
  idx('world')
)});console[_0xw(${hex(idx('log'))})](_0xg+_0xw(${hex(idx(' '))})+_0xt);function inner(){var _0xw2=_0xw;return ['a','b','c'][_0xw2(${hex(
  idx('join')
)})](_0xw2(${hex(idx('-'))}));}console[_0xw(${hex(idx('log'))})](inner()[_0xw(${hex(
  idx('toUpperCase')
)})]());}main();
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'legacy-decoder.s1.obf.js');
fs.writeFileSync(outFile, code, 'utf8');
console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
