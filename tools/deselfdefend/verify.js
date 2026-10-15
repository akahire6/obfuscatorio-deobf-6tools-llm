#!/usr/bin/env node
'use strict';

/**
 * verify.js — strip-self-defending.js の自動検証。
 *
 * testdata/obf/ の各サンプル（gen-corpus.js が新規に生成したもの。
 * JsDeObsBench のデータセットは使わない）について次を確かめる:
 *
 *   [strip]    self-defending を検出して除去できた
 *   [parse]    出力が JS としてパースできる
 *   [bytes]    出力が「入力から報告した 3 区間を切り出しただけ」と完全に一致する
 *   [layers]   全ノード種別で 入力 − 除去部品 = 出力（= 他 6 変換に触れていない証明）
 *   [compact]  入力が 1 行なら出力も 1 行（= code-compact を解除していない）
 *   [residue]  もう一度掛けると「対象なし」になる（= 残骸ゼロ）
 *   [idem]     2 回目の適用で 1 バイトも変わらない
 *   [marks]    debug-protection の目印が出力に残っている（seven のみ）
 *   [behave]   原本・難読化後・解除後の 3 つが同じ stdout と終了コードを返す
 *   [trap]     解除前のコードは整形すると罠が作動する（= 消した罠が本物だった証明）
 *   [beautify] 解除後のコードは整形しても罠に落ちず、原本と同じ結果を返す
 *
 * さらに負例として:
 *   no-self / debug-only  1 バイトも変えないこと（誤検出ゼロ）
 *   hard-self             黙って壊れたコードを出さず理由つきで失敗すること
 *   非対象入力            難読化していないコードを壊さないこと
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const { stripSelfDefending, StripError, typeHistogram } = require('./strip-self-defending.js');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'testdata', 'src');
const OBF_DIR = path.join(ROOT, 'testdata', 'obf');
const TMP_DIR = path.join(ROOT, 'testdata', '.verify-tmp');

const PARSER_OPTIONS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true
};

/** debug-protection が残っていることの目印。self-defending だけを消した証拠になる。 */
const DEBUG_PROTECTION_MARKS = ['function *\\( *\\)', 'while (true) {}', '\\+\\+ *(?:[a-zA-Z_$][0-9a-zA-Z_$]*)'];

/** 罠が作動したと見なすまでの待ち時間。catastrophic backtracking は事実上無限なのでこれで十分。 */
const TRAP_TIMEOUT_MS = 3000;
const RUN_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------

function histogram(code) {
  const ast = parser.parse(code, PARSER_OPTIONS);
  return typeHistogram([ast.program]);
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

/** コードを整形する（self-defending にとっては「改行が入る」ことがすべて）。 */
function beautify(code) {
  const ast = parser.parse(code, PARSER_OPTIONS);
  return generate(ast, { compact: false, comments: false, retainLines: false }).code;
}

/** node で走らせて stdout と終了コードを取る。stdin フィクスチャがあれば与える。 */
function run(file, stdinFile, timeout) {
  const input = stdinFile && fs.existsSync(stdinFile) ? fs.readFileSync(stdinFile) : Buffer.alloc(0);
  try {
    const stdout = execFileSync(process.execPath, [file], {
      input,
      timeout: timeout || RUN_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { code: 0, stdout: stdout.toString(), timedOut: false };
  } catch (err) {
    return {
      code: err.status === undefined || err.status === null ? -1 : err.status,
      stdout: err.stdout ? err.stdout.toString() : '',
      timedOut: err.killed === true || err.signal === 'SIGTERM',
      error: err.message
    };
  }
}

let tmpSeq = 0;
function writeTmp(name, code) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `${tmpSeq++}.${name}`);
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------

function checkSample(configName, obfFile, opts) {
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
    result = stripSelfDefending(obfCode);
  } catch (err) {
    return { base, checks: [{ name: 'strip', ok: false, msg: err.message.split('\n')[0] }] };
  }
  if (!result.changed) {
    return { base, checks: [{ name: 'strip', ok: false, msg: 'self-defending を検出できなかった' }] };
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

  // [bytes] 報告した区間を入力から抜くと出力と 1 バイト違わず一致する
  {
    let rebuilt = obfCode;
    for (const [s, e] of result.stats.removedRanges.slice().sort((a, b) => b[0] - a[0])) {
      rebuilt = rebuilt.slice(0, s) + rebuilt.slice(e);
    }
    if (rebuilt === out) pass('bytes');
    else fail('bytes', '出力が「入力から報告区間を抜いたもの」と一致しない');
  }

  // [layers] 全ノード種別で 入力 − 除去部品 = 出力
  {
    const hObf = histogram(obfCode);
    const hOut = histogram(out);
    const removed = typeHistogram(result.removedNodes);
    const types = new Set([...Object.keys(hObf), ...Object.keys(hOut), ...Object.keys(removed)]);
    const drift = [];
    for (const type of types) {
      const expected = (hObf[type] || 0) - (removed[type] || 0);
      const actual = hOut[type] || 0;
      if (expected !== actual) drift.push(`${type}: 期待 ${expected} / 実際 ${actual}`);
    }
    if (drift.length === 0) pass('layers');
    else fail('layers', drift.join(', '));
  }

  // [compact] 入力が 1 行なら出力も 1 行
  if (!obfCode.trimEnd().includes('\n')) {
    if (out.trimEnd().includes('\n')) fail('compact', '出力に改行が入った');
    else pass('compact');
  }

  // [residue] / [idem]
  try {
    const second = stripSelfDefending(out);
    if (second.changed) fail('residue', 'self-defending 部品がまだ残っている');
    else pass('residue');
    if (!second.changed) {
      if (second.code === out) pass('idem');
      else fail('idem', '2 回目の適用で出力が変わった');
    }
  } catch (err) {
    fail('residue', err.message.split('\n')[0]);
  }

  // [marks] debug-protection の目印が残っている（seven 構成のみ）
  if (configName === 'seven') {
    const lits = stringLiterals(out);
    if (DEBUG_PROTECTION_MARKS.some((m) => lits.has(m))) pass('marks');
    else fail('marks', 'debug-protection の目印まで消えている');
  }

  // [behave] 原本・難読化後・解除後で stdout と終了コードが一致
  const outFile = writeTmp(`${configName}.${base}.nosd.js`, out);
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
      `${hasSrc ? `src(${rSrc.code}) / ` : ''}obf(${rObf.code}) / nosd(${rOut.code}) ` +
        `stdout一致 obf=${rObf.stdout === rOut.stdout}${hasSrc ? ` src=${rSrc.stdout === rOut.stdout}` : ''}` +
        (rOut.error ? ` err=${rOut.error.split('\n')[0]}` : '')
    );
  }

  // [trap] / [beautify] 整形して罠を試す
  if (opts.beautify) {
    let beforeFile = null;
    let afterFile = null;
    try {
      beforeFile = writeTmp(`${configName}.${base}.obf.pretty.js`, beautify(obfCode));
      afterFile = writeTmp(`${configName}.${base}.nosd.pretty.js`, beautify(out));
    } catch (err) {
      fail('beautify', `整形できない: ${err.message.split('\n')[0]}`);
    }

    if (beforeFile && afterFile) {
      // 解除前: 罠が作動して、正しい結果を返さない（ふつうはタイムアウト）
      const rBefore = run(beforeFile, inFile, TRAP_TIMEOUT_MS);
      const trapFired = rBefore.timedOut || rBefore.stdout !== rOut.stdout || rBefore.code !== rOut.code;
      if (trapFired) pass('trap');
      else fail('trap', '整形しても罠が作動しなかった（消したものが罠だったと言い切れない）');

      // 解除後: 罠に落ちず、原本と同じ結果
      const rAfter = run(afterFile, inFile, RUN_TIMEOUT_MS);
      if (rAfter.timedOut) {
        fail('beautify', `整形後にハングした（${TRAP_TIMEOUT_MS}ms 超）`);
      } else if (rAfter.stdout === rOut.stdout && rAfter.code === rOut.code) {
        pass('beautify');
      } else {
        fail('beautify', `整形後の結果が違う code=${rAfter.code}${rAfter.error ? ' ' + rAfter.error.split('\n')[0] : ''}`);
      }
    }
  }

  return { base, checks };
}

// ---------------------------------------------------------------------------

/** 負例: 1 バイトも変えてはいけない構成。 */
function verifyNoop(configName) {
  const dir = path.join(OBF_DIR, configName);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.obf.js')).sort()) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      const r = stripSelfDefending(code);
      const ok = !r.changed && r.code === code;
      rows.push({ base: f, checks: [{ name: 'nodefend', ok, msg: ok ? '' : '入力が改変された' }] });
    } catch (err) {
      rows.push({ base: f, checks: [{ name: 'nodefend', ok: false, msg: err.message.split('\n')[0] }] });
    }
  }
  return rows;
}

/** 負例: 対象外設定では、黙って壊れたコードを出さず必ず失敗する。 */
function verifyHardConfig() {
  const dir = path.join(OBF_DIR, 'hard-self');
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.obf.js')).sort()) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    let ok = false;
    let msg = '';
    try {
      const r = stripSelfDefending(code, { timeout: 1500 });
      ok = false;
      msg = r.changed ? '対象外設定なのに成功扱いになった（要確認）' : 'self-defending を見落とした';
    } catch (err) {
      ok = err instanceof StripError;
      msg = ok ? '' : `StripError 以外の例外: ${err.message}`;
    }
    rows.push({ base: f, checks: [{ name: 'refuse', ok, msg }] });
  }
  return rows;
}

/** 負例: 難読化していないコードを入れても何も壊さない。 */
function verifyPlainSources() {
  const rows = [];
  for (const f of fs.readdirSync(SRC_DIR).filter((x) => x.endsWith('.js')).sort()) {
    const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    try {
      const r = stripSelfDefending(code);
      const ok = !r.changed && r.code === code;
      rows.push({ base: f, checks: [{ name: 'nontarget', ok, msg: ok ? '' : '入力が改変された' }] });
    } catch (err) {
      rows.push({ base: f, checks: [{ name: 'nontarget', ok: false, msg: err.message.split('\n')[0] }] });
    }
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
  const skipBeautify = process.argv.includes('--no-beautify');
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  let failed = 0;

  for (const configName of ['seven', 'self-only']) {
    const dir = path.join(OBF_DIR, configName);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.obf.js'))
      .sort()
      .map((f) => path.join(dir, f));
    failed += report(
      `${configName} (${files.length} サンプル)`,
      files.map((f) => checkSample(configName, f, { beautify: !skipBeautify }))
    );
  }

  failed += report('負例 no-self — self-defending 以外の6変換を1バイトも変えないこと', verifyNoop('no-self'));
  failed += report('負例 debug-only — 紛らわしい debug-protection を消さないこと', verifyNoop('debug-only'));
  failed += report('負例 hard-self — 理由つきで失敗すること', verifyHardConfig());
  failed += report('非対象入力 — 難読化していないコードを壊さないこと', verifyPlainSources());

  console.log(`\n${failed === 0 ? '全項目 PASS' : `${failed} 件の失敗`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
