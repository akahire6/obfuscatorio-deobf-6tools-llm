#!/usr/bin/env node
'use strict';

/**
 * 検証用コーパスの生成。
 *
 * testdata/src/*.js を configs/*.json の難読化設定で難読化し、
 * testdata/obf/<config>/ に置く。
 *
 * ★ JsDeObsBench のデータセットは一切使わない。スクリプトを特定のデータに
 *   過適合させないため、開発と検証はここで生成したコードだけで行う。
 *
 * ソースは 20 本:
 *   01〜12  destring と共通（storage 辞書の検証に十分。switch は出ない）
 *   13〜20  CFF 用に書き下ろした ES5 スタイル（switch ディスパッチャを発火させる）
 *
 * ★ 13〜20 が ES5 スタイルなのは好みではなく必須条件。obfuscator.io の
 *   BlockStatementControlFlowTransformer は canTransformBlockStatementNode で
 *     - ブロック直下が 5 文未満
 *     - 部分木に FunctionDeclaration / break / continue / let / const / class
 *   のいずれかがあるブロックを対象外にする（while の内側は見ない）。
 *   01〜12 は全部 ES6 スタイルなので、1 ブロックも平坦化されない。
 *
 * 設定の狙い:
 *   seven     7 変換すべて。本命。発火確率 0.75 なので 5 シード
 *   cff-only  CFF 単体・名前そのまま・整形あり・文字列配列なし
 *             （= 文字列層コンテキストが無い経路を通す）
 *   no-cff    CFF 以外の 6 変換（負例。1 バイトも変えてはいけない）
 *   cff-hard  文字列層のデコーダを組み立てられない設定（負例。理由つきで失敗すること）
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
  seven: [1, 2, 3, 4, 5],
  'cff-only': [1, 2, 3],
  'no-cff': [1],
  'cff-hard': [1]
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

    for (const src of sources) {
      const code = fs.readFileSync(path.join(SRC_DIR, src), 'utf8');
      const base = src.replace(/\.js$/, '');

      for (const seed of seeds) {
        const result = JavaScriptObfuscator.obfuscate(code, Object.assign({}, options, { seed }));
        fs.writeFileSync(path.join(outDir, `${base}.s${seed}.obf.js`), result.getObfuscatedCode(), 'utf8');
        written += 1;

        // 標準入力フィクスチャがあれば並べて置く（verify.js が使う）
        const inFile = path.join(SRC_DIR, base + '.in');
        if (fs.existsSync(inFile)) {
          fs.copyFileSync(inFile, path.join(outDir, `${base}.s${seed}.obf.in`));
        }
      }
    }

    console.log(`${configName}: ${sources.length} sources x ${seeds.length} seed(s)`);
  }

  console.log(`\ngenerated ${written} obfuscated files under ${path.relative(process.cwd(), OBF_DIR)}/`);
}

main();
