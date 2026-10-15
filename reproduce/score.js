#!/usr/bin/env node
/**
 * 上流 eval.py が書いた <name>.metrics.jsonl から、論文と同じ 5 列を出す。
 * 集計の定義は上流 read_scores_for_leaderboard.py の read_scores() と同じ:
 *
 *   syntax       全行の syntax_pass の平均（欠けている行は 0）
 *   exec         全行の exe_pass の平均（欠けている行は 0）
 *   decomplexity code_complexity がある行（= 構文が通った行）の new_decrease_halstead_len の平均
 *   similarity   code_bleu がある行の codebleu（CodeBLEU）の平均
 *   overall      上の 4 つの単純平均
 *
 * 使い方: node reproduce/score.js <a.metrics.jsonl> [<b.metrics.jsonl> ...]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function score(file) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const syntax = mean(rows.map((r) => Number(r.syntax_pass ?? 0))) * 100;
  const exec = mean(rows.map((r) => Number(r.exe_pass ?? 0))) * 100;
  const decomplexity = mean(rows.filter((r) => r.code_complexity).map((r) => r.code_complexity.new_decrease_halstead_len)) * 100;
  const similarity = mean(rows.filter((r) => r.code_bleu).map((r) => r.code_bleu.codebleu)) * 100;
  const overall = mean([syntax, exec, decomplexity, similarity]);
  return { n: rows.length, syntax, exec, decomplexity, similarity, overall };
}

const files = process.argv.slice(2);
if (!files.length) {
  process.stderr.write('使い方: node reproduce/score.js <a.metrics.jsonl> [...]\n');
  process.exit(2);
}
const f2 = (v) => v.toFixed(2);
console.log('| file | n | syntax | exec | decomplexity | similarity | overall |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const file of files) {
  const s = score(file);
  console.log(`| ${path.basename(file)} | ${s.n} | ${f2(s.syntax)} | ${f2(s.exec)} | ${f2(s.decomplexity)} | ${f2(s.similarity)} | ${f2(s.overall)} |`);
}
