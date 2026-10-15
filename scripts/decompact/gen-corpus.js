#!/usr/bin/env node
'use strict';

/**
 * 検証用コーパスの生成。
 *
 * testdata/src/*.js（このスクリプトのために書き下ろしたプログラム）を configs/*.json の
 * 難読化設定で難読化し、testdata/obf/<config>/ に置く。
 *
 * ★ JsDeObsBench のデータセットは一切使わない。スクリプトを特定のデータに
 *   過適合させないため、開発と検証はここで生成したコードだけで行う。
 *
 * ★ destring の gen-corpus.js との違い: 入力と**正解 (gold) を対で**書く。
 *   code-compact の解除は「難読化器が compact:false で出したはずのコードに戻す」
 *   ことなので、同じ seed で compact だけ false にして再難読化すれば
 *   バイト単位の正解が手に入る。
 *
 *     <base>.s<seed>.obf.js   compact: true   ← スクリプトへの入力
 *     <base>.s<seed>.gold.js  compact: false  ← 期待する出力（バイト比較）
 *
 * ★ ただし seven 構成では gold を作れない。javascript-obfuscator の
 *   SelfDefendingRule が `selfDefending: true` のとき `compact` を true に
 *   上書きするため、compact:false を指定しても同じ 1 行出力が返る。
 *   その場合は gold を書かず、no-gold.txt に理由を残す。
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'testdata', 'src');
const OBF_DIR = path.join(ROOT, 'testdata', 'obf');
const CONFIG_DIR = path.join(ROOT, 'configs');

// 設定名 -> 使うシード
const MATRIX = {
  'compact-only': [1],
  'six-nosd': [1, 2, 3],
  seven: [1, 2, 3]
};

function loadConfig(name) {
  const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name + '.json'), 'utf8'));
  // "_comment" は javascript-obfuscator の未知オプションなので落とす
  delete raw._comment;
  return raw;
}

function main() {
  fs.rmSync(OBF_DIR, { recursive: true, force: true });

  const sources = fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  let written = 0;

  for (const [configName, seeds] of Object.entries(MATRIX)) {
    const options = loadConfig(configName);
    const outDir = path.join(OBF_DIR, configName);
    fs.mkdirSync(outDir, { recursive: true });

    let golds = 0;
    let noGold = 0;

    for (const src of sources) {
      const code = fs.readFileSync(path.join(SRC_DIR, src), 'utf8');
      const base = src.replace(/\.js$/, '');

      for (const seed of seeds) {
        const obf = JavaScriptObfuscator.obfuscate(
          code,
          Object.assign({}, options, { seed, compact: true })
        ).getObfuscatedCode();
        const gold = JavaScriptObfuscator.obfuscate(
          code,
          Object.assign({}, options, { seed, compact: false })
        ).getObfuscatedCode();

        fs.writeFileSync(path.join(outDir, `${base}.s${seed}.obf.js`), obf, 'utf8');
        written += 1;

        if (gold === obf) {
          // compact:false を指定しても compact のまま = 正解が生成できない構成
          noGold += 1;
        } else {
          fs.writeFileSync(path.join(outDir, `${base}.s${seed}.gold.js`), gold, 'utf8');
          golds += 1;
        }

        // 標準入力フィクスチャがあれば並べて置く（verify.js が使う）
        const inFile = path.join(SRC_DIR, base + '.in');
        if (fs.existsSync(inFile)) {
          fs.copyFileSync(inFile, path.join(outDir, `${base}.s${seed}.obf.in`));
        }
      }
    }

    if (noGold > 0) {
      fs.writeFileSync(
        path.join(outDir, 'no-gold.txt'),
        `この構成では ${noGold} 件すべてで compact:false の正解を生成できない。\n` +
          'javascript-obfuscator の SelfDefendingRule が selfDefending:true のとき\n' +
          'compact を true に上書きするため、compact:false を指定しても同じ出力が返る。\n' +
          '  SelfDefendingRule = e => (e.selfDefending && (e = {...e, compact: true, selfDefending: true}), e)\n' +
          'この構成の検証は gold バイト比較ではなく AST 同型性で行う（verify.js の ast 検査）。\n',
        'utf8'
      );
    }

    console.log(
      `${configName}: ${sources.length} sources x ${seeds.length} seed(s)` +
        ` -> gold ${golds} 件 / gold 生成不能 ${noGold} 件`
    );
  }

  console.log(`\ngenerated ${written} obfuscated files under ${path.relative(process.cwd(), OBF_DIR)}/`);
}

main();
