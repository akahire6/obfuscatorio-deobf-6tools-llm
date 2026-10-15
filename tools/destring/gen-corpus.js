#!/usr/bin/env node
'use strict';

/**
 * 検証用コーパスの生成。
 *
 * testdata/src/*.js（このツールのために新しく書き下ろしたプログラム）を
 * configs/*.json の難読化設定で難読化し、testdata/obf/<config>/ に置く。
 *
 * ★ JsDeObsBench のデータセットは一切使わない。ツールを特定のデータに
 *   過適合させないため、開発と検証はここで生成したコードだけで行う。
 *
 * stringArrayRotate / stringArrayShuffle は乱数を使うので、シードを変えると
 * 配列の並びも部品の出現順序も変わる。形の揹れを当てるため複数シードで回す。
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
  'string-only': [1],
  hard: [1]
};

function loadConfig(name) {
  const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name + '.json'), 'utf8'));
  // "_comment" は javascript-obfuscator の未知オプションなので落とす
  delete raw._comment;
  return raw;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function main() {
  rmrf(OBF_DIR);

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
        const outName = `${base}.s${seed}.obf.js`;
        fs.writeFileSync(path.join(outDir, outName), result.getObfuscatedCode(), 'utf8');
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

  // 旧世代デコーダ形式（javascript-obfuscator 4.x 系の自己書き換えデコーダ）は
  // 手元の 5.7.0 では生成できないので、専用スクリプトで一から組み立てる。
  require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'gen-legacy-fixture.js')], {
    stdio: 'inherit'
  });

  console.log(`\ngenerated ${written} obfuscated files under ${path.relative(process.cwd(), OBF_DIR)}/`);
}

main();
