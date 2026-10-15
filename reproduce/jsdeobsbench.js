#!/usr/bin/env node
/**
 * JsDeObsBench（CCS'25）のデータで結果を再現するための補助。
 *
 *   extract  上流の Project_CodeNet_selected.jsonl から、問題リストの難読化コードを
 *            1 問 1 ファイル（<filename>.obf.js）に書き出す
 *   pack     解除結果のディレクトリを、上流 eval.py が読める results jsonl にまとめる
 *   example  oneshot プロンプトの {example} に入る文を、上流 examples.json から作る
 *            （上流 deobfuscators/utils.py の build_example_prompt() と同じ文字列）
 *
 * 使い方:
 *   node reproduce/jsdeobsbench.js extract <dataset.jsonl> <subset.json> <outdir>
 *   node reproduce/jsdeobsbench.js pack <dataset.jsonl> <subset.json> <deobf_dir> <out.jsonl> [--suffix .deobf.js]
 *   node reproduce/jsdeobsbench.js example <examples.json> [combinations/C77-0] > example.txt
 *
 * subset.json は {"filenames": ["p00016_1", ...]} の形（reproduce/subset_n30.json など）。
 * pack では、解除結果が無い・空の問題も行として残し deobfuscated: "" とする。
 * 上流の評価器は空を syntax 不合格（0 点）として数えるので、解けなかった問題が母数から消えない。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function loadDataset(file) {
  const byName = new Map();
  for (const row of readJsonl(file)) byName.set(row.filename, row);
  return byName;
}

function loadSubset(file, dataset) {
  const names = JSON.parse(fs.readFileSync(file, 'utf8')).filenames;
  const missing = names.filter((n) => !dataset.has(n));
  if (missing.length) throw new Error(`データセットに無い問題: ${missing.join(', ')}`);
  return names;
}

function extract([datasetFile, subsetFile, outDir]) {
  if (!outDir) usage();
  const dataset = loadDataset(datasetFile);
  const names = loadSubset(subsetFile, dataset);
  fs.mkdirSync(outDir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(outDir, `${n}.obf.js`), dataset.get(n).obfuscated);
  process.stderr.write(`${names.length} 問を ${outDir} に書き出しました\n`);
}

function pack(args) {
  let suffix = '.deobf.js';
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suffix') suffix = args[++i];
    else pos.push(args[i]);
  }
  const [datasetFile, subsetFile, deobfDir, outFile] = pos;
  if (!outFile) usage();
  const dataset = loadDataset(datasetFile);
  const names = loadSubset(subsetFile, dataset);

  const counts = { present: 0, empty: 0, missing: 0 };
  const lines = names.map((n) => {
    const row = { ...dataset.get(n) }; // filename / type / obfuscated / original / test_cases / language
    const f = path.join(deobfDir, n + suffix);
    let deobf = '';
    if (fs.existsSync(f)) {
      deobf = fs.readFileSync(f, 'utf8');
      counts[deobf.trim() ? 'present' : 'empty'] += 1;
    } else {
      counts.missing += 1;
    }
    row.deobfuscated = deobf;
    return JSON.stringify(row);
  });
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  process.stderr.write(
    `${names.length} 行 → ${outFile}（解除あり ${counts.present} / 空 ${counts.empty} / 欠損 ${counts.missing}）\n`
  );
  if (counts.missing) process.stderr.write('[!] 欠損は deobfuscated="" として 0 点で数えられます\n');
}

function example([examplesFile, config = 'combinations/C77-0']) {
  if (!examplesFile) usage();
  const examples = JSON.parse(fs.readFileSync(examplesFile, 'utf8'))[config];
  if (!examples || !examples.length) throw new Error(`${examplesFile} に ${config} の例がありません`);
  // build_example_prompt(examples, num_examples=1) と同じ。先頭の改行も含めて一致させる。
  const ex = examples[0];
  process.stdout.write(
    '\nInput obfuscated JavaScript code:\n```javascript\n' + ex.obfuscated +
    '\n```\n\nOutput deobfuscated JavaScript code:\n```javascript\n' + ex.original + '\n```\n'
  );
}

function usage() {
  process.stderr.write(`使い方:
  node reproduce/jsdeobsbench.js extract <dataset.jsonl> <subset.json> <outdir>
  node reproduce/jsdeobsbench.js pack <dataset.jsonl> <subset.json> <deobf_dir> <out.jsonl> [--suffix .deobf.js]
  node reproduce/jsdeobsbench.js example <examples.json> [combinations/C77-0] > example.txt
`);
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'extract') extract(rest);
else if (cmd === 'pack') pack(rest);
else if (cmd === 'example') example(rest);
else usage();
