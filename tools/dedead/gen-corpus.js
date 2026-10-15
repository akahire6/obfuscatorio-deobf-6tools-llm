#!/usr/bin/env node
'use strict';

/**
 * 検証用コーパスの生成。
 *
 * testdata/src/*.js（このツールのために書き下ろしたプログラム）を
 * configs/*.json の難読化設定で難読化し、testdata/obf/<config>/ に置く。
 *
 * ★ JsDeObsBench のデータセットは一切使わない。ツールを特定のデータに
 *   過適合させないため、開発と検証はここで生成したコードだけで行う。
 *
 * 設定ごとの狙い:
 *   seven          本番相当（7 変換すべて）。述語が二重に間接化される
 *   dead-max       CFF なし・最大発火。直リテラル述語の経路を単独で見る
 *   dead-cff       deadcode + CFF だけ。辞書解決の経路を単独で見る
 *   deadcode-only  deadcode + 強制で付く文字列配列だけ
 *   objkeys        transformObjectKeys で辞書が引けない負例（剥がし残して正常終了）
 *   hard           デコーダを組み立てられない負例（同上）
 *   string-only    deadcode を掛けていない非対象入力（1 バイトも変えないこと）
 *   destr          seven / dead-max に ../destring を先に掛けたもの。
 *                  文字列配列が無い状態でも述語を読めることを確かめる入力クラス
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const destring = require('../destring/strip-string-obfuscation.js');
const { stripDeadCodeInjection } = require('./strip-deadcode-injection.js');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'testdata', 'src');
const OBF_DIR = path.join(ROOT, 'testdata', 'obf');
const CONFIG_DIR = path.join(ROOT, 'configs');

// 設定名 -> 使うシード
const MATRIX = {
  seven: [1, 2, 3],
  'dead-max': [1, 2],
  'dead-cff': [1],
  'deadcode-only': [1],
  objkeys: [1],
  hard: [1],
  'string-only': [1]
};

// destring を先に掛けた入力クラスを、どの設定から作るか
const DESTR_FROM = ['seven', 'dead-max'];

// 全サンプルで deadcode が検出できないといけない設定。
// ここが欠けると「入っていないサンプルで PASS した」を成功と誤認する。
const MUST_FIRE = new Set(['seven', 'destr-seven']);

// deadcode を掛けていない設定（検出 0 が正しい）
const NO_DEADCODE = new Set(['string-only']);

// 死コードは入っているが述語を読めないことを確かめる負例（検出 0 や部分検出が正しい）
const DEGRADE = new Set(['hard', 'objkeys']);

function loadConfig(name) {
  const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name + '.json'), 'utf8'));
  // "_comment" は javascript-obfuscator の未知オプションなので落とす
  delete raw._comment;
  return raw;
}

/** 生成したサンプルに実際に deadcode が入ったかを数える。0 件なら穴なので報告する。 */
function countDeadIfs(file) {
  try {
    const r = stripDeadCodeInjection(fs.readFileSync(file, 'utf8'), { selfCheck: false });
    return r.stats.resolved;
  } catch (_) {
    return -1; // 解除自体が失敗する設定（負例）。verify.js 側で扱う
  }
}

function main() {
  fs.rmSync(OBF_DIR, { recursive: true, force: true });

  const sources = fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  const written = [];

  for (const [configName, seeds] of Object.entries(MATRIX)) {
    const options = loadConfig(configName);
    const outDir = path.join(OBF_DIR, configName);
    fs.mkdirSync(outDir, { recursive: true });

    for (const src of sources) {
      const code = fs.readFileSync(path.join(SRC_DIR, src), 'utf8');
      const base = src.replace(/\.js$/, '');

      for (const seed of seeds) {
        const result = JavaScriptObfuscator.obfuscate(code, Object.assign({}, options, { seed }));
        const outFile = path.join(outDir, `${base}.s${seed}.obf.js`);
        fs.writeFileSync(outFile, result.getObfuscatedCode(), 'utf8');
        written.push({ config: configName, file: outFile });

        // 標準入力フィクスチャがあれば並べて置く（verify.js が使う）
        const inFile = path.join(SRC_DIR, base + '.in');
        if (fs.existsSync(inFile)) {
          fs.copyFileSync(inFile, path.join(outDir, `${base}.s${seed}.obf.in`));
        }
      }
    }

    console.log(`${configName}: ${sources.length} sources x ${seeds.length} seed(s)`);
  }

  // --- destring を先に掛けた入力クラス --------------------------------------
  // 文字列配列が無く、述語が可読リテラルか辞書参照になっている状態。
  for (const from of DESTR_FROM) {
    const configName = `destr-${from}`;
    const srcDir = path.join(OBF_DIR, from);
    const destrDir = path.join(OBF_DIR, configName);
    fs.mkdirSync(destrDir, { recursive: true });
    let n = 0;

    for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.obf.js')).sort()) {
      const code = fs.readFileSync(path.join(srcDir, f), 'utf8');
      let stripped;
      try {
        stripped = destring.stripStringObfuscation(code).code;
      } catch (err) {
        console.log(`  ${configName}: ${f} は destring が剥がせないので飛ばす (${err.message.split('\n')[0]})`);
        continue;
      }
      fs.writeFileSync(path.join(destrDir, f), stripped, 'utf8');
      written.push({ config: configName, file: path.join(destrDir, f) });
      n += 1;

      const inFile = path.join(srcDir, f.replace(/\.obf\.js$/, '.obf.in'));
      if (fs.existsSync(inFile)) {
        fs.copyFileSync(inFile, path.join(destrDir, f.replace(/\.obf\.js$/, '.obf.in')));
      }
    }
    console.log(`${configName}: ${n} files (${from} に ../destring を先に掛けたもの)`);
  }

  // --- 発火の確認 -----------------------------------------------------------
  // deadCodeInjection は収集できるブロックが 5 個未満だと何も入れない。
  // 「そもそも入っていないサンプルで PASS した」を成功と誤認しないよう、ここで数えておく。
  const tally = new Map(); // config -> { files, fired, hits, empty: [] }
  for (const { config, file } of written) {
    if (!tally.has(config)) tally.set(config, { files: 0, fired: 0, hits: 0, empty: [] });
    const row = tally.get(config);
    row.files += 1;
    const n = countDeadIfs(file);
    if (n > 0) {
      row.fired += 1;
      row.hits += n;
    } else {
      row.empty.push(path.basename(file));
    }
  }

  console.log(`\ngenerated ${written.length} files under ${path.relative(process.cwd(), OBF_DIR)}/`);
  console.log('\n設定ごとの発火状況（検出できた deadcode の件数）:');
  const note = (c) =>
    NO_DEADCODE.has(c) ? '  (deadcode を掛けていない。検出 0 が正しい)'
      : DEGRADE.has(c) ? '  (述語が読めない負例。検出 0 や部分検出が正しい)'
      : MUST_FIRE.has(c) ? '  (全サンプルで検出できないといけない)'
      : '  (小さいソースには注入されない。deadCodeInjection は収集ブロック 5 個未満だと発火しない)';
  for (const [config, row] of tally) {
    console.log(`  ${config.padEnd(14)} ${String(row.fired).padStart(3)}/${String(row.files).padEnd(3)} sample fired, ${String(row.hits).padStart(4)} hits${note(config)}`);
  }

  const holes = [];
  for (const config of MUST_FIRE) {
    const row = tally.get(config);
    if (row) for (const f of row.empty) holes.push(`${config}/${f}`);
  }
  if (holes.length) {
    console.log(`\n★ 検出できないといけないのに 0 件だったサンプル ${holes.length} 件:`);
    for (const h of holes) console.log(`  - ${h}`);
    process.exitCode = 1;
  } else {
    console.log('\n検出が必須の設定（' + [...MUST_FIRE].join(' / ') + '）は全サンプルで 1 件以上検出できている。');
  }
}

main();
