#!/usr/bin/env node
'use strict';

/**
 * 検証用コーパスの生成。
 *
 * testdata/src/*.js（destring と共通の書き下ろしプログラム）を
 * configs/*.json の難読化設定で難読化し、testdata/obf/<config>/ に置く。
 *
 * ★ JsDeObsBench のデータセットは一切使わない。ツールを特定のデータに
 *   過適合させないため、開発と検証はここで生成したコードだけで行う。
 *
 * 設定の狙い:
 *   seven       7 変換すべて。本命。乱数が絡むので 3 シード
 *   self-only   self-defending 単体・名前そのまま・整形あり・文字列配列なし
 *   no-self     self-defending 以外の 6 変換（負例。1 バイトも変えてはいけない）
 *   debug-only  debug-protection 単体（負例。同じ形のラッパを持つ紛らわしい方）
 *   hard-self   デコーダを組み立てられない設定（負例。理由つきで失敗すること）
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
  seven: [1, 2, 3],
  'self-only': [1],
  'no-self': [1],
  'debug-only': [1],
  'hard-self': [1]
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
