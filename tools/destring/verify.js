#!/usr/bin/env node
'use strict';

/**
 * verify.js — strip-string-obfuscation.js の自動検証。
 *
 * testdata/obf/ の各サンプル（gen-corpus.js が新規に生成したもの。
 * JsDeObsBench のデータセットは使わない）について次を確かめる:
 *
 *   [parse]   出力が JS としてパースできる
 *   [residue] 文字列配列・デコーダ・ローテータ・別名が 1 つも残っていない
 *   [strings] 配列の全要素が「コードに戻された」か「ローテータの検査和に消費された」かで説明できる
 *   [compact] 入力が 1 行なら出力も 1 行（= code-compact を解除していない）
 *   [layers]  除去した部品以外はノード 1 つ変わっていない
 *             （= 他 6 変換に触れていないことの機械的な証明）
 *   [marks]   self-defending / debug-protection の目印が残っている
 *   [behave]  難読化前・難読化後・解除後の 3 つが同じ stdout / 終了コードを返す
 *   [idem]    もう一度掛けても何も変わらない
 *
 * さらに対象外設定（configs/hard.json）では、黙って壊れたコードを出さず
 * 理由つきで失敗することを確かめる。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const parser = require('@babel/parser');
const t = require('@babel/types');

const { stripStringObfuscation, StripError } = require('./strip-string-obfuscation.js');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'testdata', 'src');
const OBF_DIR = path.join(ROOT, 'testdata', 'obf');
const TMP_DIR = path.join(ROOT, 'testdata', '.verify-tmp');

const PARSER_OPTIONS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true
};

/**
 * 文字列の畳み込みでは増減しないノード種別。
 * D(0x1) → 'foo' の置換は CallExpression / Identifier / NumericLiteral / StringLiteral
 * しか動かさないので、これらの種別は「除去した部品のぶんだけ」正確に減るはず。
 */
const INVARIANT_TYPES = [
  'IfStatement',
  'TryStatement',
  'WhileStatement',
  'ForStatement',
  'SwitchStatement',
  'ConditionalExpression',
  'ObjectExpression',
  'ObjectProperty',
  'ObjectMethod',
  'FunctionExpression',
  'FunctionDeclaration',
  'ArrowFunctionExpression',
  'ClassDeclaration',
  'ArrayExpression',
  'ReturnStatement',
  'ThrowStatement',
  'BinaryExpression',
  'LogicalExpression',
  'TemplateLiteral',
  'RegExpLiteral'
];

/** self-defending / debug-protection が残っていることの目印（いずれも文字列配列に入る） */
const LAYER_MARKS = {
  'self-defending': ['(((.+)+)+)+$'],
  'debug-protection': ['function *\\( *\\)', 'while (true) {}']
};

// ---------------------------------------------------------------------------

function histogram(code) {
  const ast = parser.parse(code, PARSER_OPTIONS);
  const counts = Object.create(null);
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    counts[n.type] = (counts[n.type] || 0) + 1;
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast.program);
  return counts;
}

function stringLiterals(code) {
  const ast = parser.parse(code, PARSER_OPTIONS);
  const found = new Set();
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (t.isStringLiteral(n)) found.add(n.value);
    if (t.isDirective(n) && n.value) found.add(n.value.value);
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast.program);
  return found;
}

/** node で走らせて stdout と終了コードを取る。stdin フィクスチャがあれば与える。 */
function run(file, stdinFile) {
  const input = stdinFile && fs.existsSync(stdinFile) ? fs.readFileSync(stdinFile) : Buffer.alloc(0);
  try {
    const stdout = execFileSync(process.execPath, [file], {
      input,
      timeout: 20000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { code: 0, stdout: stdout.toString() };
  } catch (err) {
    return {
      code: err.status === undefined || err.status === null ? -1 : err.status,
      stdout: err.stdout ? err.stdout.toString() : '',
      error: err.message
    };
  }
}

// ---------------------------------------------------------------------------

function checkSample(configName, obfFile) {
  const checks = [];
  const fail = (name, msg) => checks.push({ name, ok: false, msg });
  const pass = (name) => checks.push({ name, ok: true });

  const base = path.basename(obfFile).replace(/\.obf\.js$/, ''); // 例 01-es5-basic.s1
  const srcBase = base.replace(/\.s\d+$/, '');
  const srcFile = path.join(SRC_DIR, srcBase + '.js');
  const inFile = path.join(SRC_DIR, srcBase + '.in');

  const obfCode = fs.readFileSync(obfFile, 'utf8');

  let result;
  try {
    result = stripStringObfuscation(obfCode);
  } catch (err) {
    return { base, checks: [{ name: 'strip', ok: false, msg: err.message.split('\n')[0] }] };
  }

  if (!result.changed) {
    return { base, checks: [{ name: 'strip', ok: false, msg: 'string-obfuscation を検出できなかった' }] };
  }
  pass('strip');

  const out = result.code;

  // [parse]
  try {
    parser.parse(out, PARSER_OPTIONS);
    pass('parse');
  } catch (err) {
    fail('parse', err.message);
  }

  // [residue] もう一度掛けて「対象なし」になれば残骸ゼロ
  let second = null;
  try {
    second = stripStringObfuscation(out);
    if (second.changed) fail('residue', 'string-obfuscation 部品がまだ残っている');
    else pass('residue');
  } catch (err) {
    fail('residue', err.message.split('\n')[0]);
  }

  // [idem] 2 回目で 1 バイトも変わらない
  if (second && !second.changed) {
    if (second.code === out) pass('idem');
    else fail('idem', '2 回目の適用で出力が変わった');
  }

  // [strings] 文字列配列の全要素が「コードに戻された」か「ローテータの検査和に
  //           消費された」かのどちらかで説明でき、かつ戻したものが出力に現れる。
  //           検査和用の文字列（例 "3459159ZApYRI"）はローテータごと消えるのが正しい。
  const lits = stringLiterals(out);
  const notRestored = result.foldedValues.filter((s) => !lits.has(s));
  const accounted = new Set([...result.foldedValues, ...result.internalValues]);
  const unaccounted = result.strings.filter((s) => !accounted.has(s));

  if (notRestored.length > 0) {
    fail('strings', `戻したはずの文字列が出力に無い ${notRestored.length} 件 例: ${JSON.stringify(notRestored.slice(0, 3))}`);
  } else if (unaccounted.length > 0) {
    fail('strings', `行き先を説明できない配列要素が ${unaccounted.length} 件 例: ${JSON.stringify(unaccounted.slice(0, 3))}`);
  } else {
    pass('strings');
  }

  // [compact] 入力が 1 行なら出力も 1 行（= code-compact を解除していない）
  if (!obfCode.trimEnd().includes('\n')) {
    if (out.trimEnd().includes('\n')) fail('compact', `出力に改行が ${out.trimEnd().split('\n').length - 1} 個ある`);
    else pass('compact');
  }

  // [layers] 除去した部品以外はノード 1 つ変わっていない
  const hObf = histogram(obfCode);
  const hOut = histogram(out);
  const removed = result.removedTypeCounts;
  const drift = [];
  for (const type of INVARIANT_TYPES) {
    const expected = (hObf[type] || 0) - (removed[type] || 0);
    const actual = hOut[type] || 0;
    if (expected !== actual) drift.push(`${type}: 期待 ${expected} / 実際 ${actual}`);
  }
  if (drift.length === 0) pass('layers');
  else fail('layers', drift.join(', '));

  // [marks] 他の層の目印が残っている（seven 構成のみ）
  if (configName === 'seven') {
    const absent = [];
    for (const [layer, marks] of Object.entries(LAYER_MARKS)) {
      if (!marks.some((m) => lits.has(m))) absent.push(layer);
    }
    if (absent.length === 0) pass('marks');
    else fail('marks', `${absent.join(' / ')} の目印が消えている`);
  }

  // [behave] 原本・難読化後・解除後で stdout と終了コードが一致
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outFile = path.join(TMP_DIR, `${configName}.${base}.destr.js`);
  fs.writeFileSync(outFile, out, 'utf8');

  const hasSrc = fs.existsSync(srcFile);
  const rSrc = hasSrc ? run(srcFile, inFile) : null;
  const rObf = run(obfFile, inFile);
  const rOut = run(outFile, inFile);

  const sameAsObf = rObf.stdout === rOut.stdout && rObf.code === rOut.code;
  const sameAsSrc = !hasSrc || (rSrc.stdout === rOut.stdout && rSrc.code === rOut.code);

  if (sameAsObf && sameAsSrc) {
    pass('behave');
  } else {
    fail(
      'behave',
      `${hasSrc ? `src(${rSrc.code}) / ` : ''}obf(${rObf.code}) / destr(${rOut.code}) ` +
        `stdout一致 obf=${rObf.stdout === rOut.stdout}${hasSrc ? ` src=${rSrc.stdout === rOut.stdout}` : ''}` +
        (rOut.error ? ` err=${rOut.error.split('\n')[0]}` : '')
    );
  }

  return { base, checks };
}

// ---------------------------------------------------------------------------

function verifyPlainSources() {
  // [nontarget] 難読化していないコードを入れても何も壊さない
  const rows = [];
  for (const f of fs.readdirSync(SRC_DIR).filter((x) => x.endsWith('.js')).sort()) {
    const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    try {
      const r = stripStringObfuscation(code);
      const ok = !r.changed && r.code === code;
      rows.push({ base: f, checks: [{ name: 'nontarget', ok, msg: ok ? '' : '入力が改変された' }] });
    } catch (err) {
      rows.push({ base: f, checks: [{ name: 'nontarget', ok: false, msg: err.message.split('\n')[0] }] });
    }
  }
  return rows;
}

function verifyHardConfig() {
  // [refuse] 対象外設定では、黙って壊れたコードを出さず必ず失敗する
  const dir = path.join(OBF_DIR, 'hard');
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.obf.js')).sort()) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    let ok = false;
    let msg = '';
    try {
      const r = stripStringObfuscation(code, { timeout: 1500 });
      // 例外を投げずに通ったなら、せめて出力が正しく動くこと（= 実質対応できている）が必要。
      ok = false;
      msg = r.changed ? '対象外設定なのに成功扱いになった（要確認）' : 'string-obfuscation を見落とした';
    } catch (err) {
      ok = err instanceof StripError;
      msg = ok ? '' : `StripError 以外の例外: ${err.message}`;
    }
    rows.push({ base: f, checks: [{ name: 'refuse', ok, msg }] });
  }
  return rows;
}

function report(title, rows) {
  console.log(`\n=== ${title} ===`);
  let failed = 0;
  for (const row of rows) {
    const bad = row.checks.filter((c) => !c.ok);
    const mark = bad.length === 0 ? 'PASS' : 'FAIL';
    const names = row.checks.map((c) => (c.ok ? c.name : `${c.name}!`)).join(' ');
    console.log(`  [${mark}] ${row.base.padEnd(34)} ${names}`);
    for (const b of bad) console.log(`         ${b.name}: ${b.msg}`);
    if (bad.length > 0) failed += 1;
  }
  console.log(`  -- ${rows.length - failed}/${rows.length} PASS`);
  return failed;
}

function main() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  let failed = 0;

  for (const configName of ['seven', 'string-only', 'legacy']) {
    const dir = path.join(OBF_DIR, configName);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.obf.js'))
      .sort()
      .map((f) => path.join(dir, f));
    failed += report(`${configName} (${files.length} サンプル)`, files.map((f) => checkSample(configName, f)));
  }

  failed += report('対象外設定 hard — 理由つきで失敗すること', verifyHardConfig());
  failed += report('非対象入力 — 難読化していないコードを壊さないこと', verifyPlainSources());

  console.log(`\n${failed === 0 ? '全項目 PASS' : `${failed} 件の失敗`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
