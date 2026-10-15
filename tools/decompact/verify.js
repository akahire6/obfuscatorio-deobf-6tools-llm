#!/usr/bin/env node
'use strict';

/**
 * verify.js — strip-code-compact.js の自動検証。
 *
 * testdata/obf/ の各サンプル（gen-corpus.js が新規に生成したもの。
 * JsDeObsBench のデータセットは使わない）について次を確かめる:
 *
 *   [strip]     code-compact を検出して整形できた
 *   [parse]     出力が JS としてパースできる
 *   [gold]      難読化器が compact:false で出すコードと**バイト単位で一致**する
 *   [ast]       入力と出力の AST が完全に一致する
 *               （= 他 6 変換に触れていないことの機械的な証明）
 *   [multiline] 入力は構造上 1 行、出力は複数行（= 実際に解除された）
 *   [idem]      出力にもう一度掛けると「対象なし」になり 1 バイトも変わらない
 *   [marks]     self-defending / debug-protection の目印が残っている
 *   [behave]    原本・難読化後・解除後の 3 つが同じ stdout / 終了コードを返す
 *   [trap]      ★ seven 構成の既定出力は**実行がタイムアウトする**
 *               （self-defending が整形を検出して発火する。失敗が期待値の検査）
 *   [guard]     ★ seven 構成を --keep-self-defending で解除した出力は正常に動く
 *
 * さらに
 *   [noop]      既に整形済みのコード（gold）を入れても 1 バイトも変えない
 *   [nontarget] 難読化していないコードを入れても 1 バイトも変えない
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn');

const { stripCodeCompact, StripError, SELF_DEFENDING_MARK } = require('./strip-code-compact.js');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'testdata', 'src');
const OBF_DIR = path.join(ROOT, 'testdata', 'obf');
const TMP_DIR = path.join(ROOT, 'testdata', '.verify-tmp');

const ACORN_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true
};

/** gold バイト比較が使える構成（self-defending を含まないもの） */
const GOLD_CONFIGS = new Set(['compact-only', 'six-nosd']);

/** self-defending / debug-protection が残っていることの目印（いずれも文字列配列に入る） */
const LAYER_MARKS = {
  'self-defending': [SELF_DEFENDING_MARK],
  'debug-protection': ['function *\\( *\\)', 'while (true) {}']
};

const BEHAVE_TIMEOUT_MS = 20000;
const TRAP_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------

function parse(code) {
  return acorn.parse(code, ACORN_OPTIONS);
}

/**
 * AST を位置情報抜きの正規形 JSON にする。
 * strip-code-compact.js 側の比較関数とは独立に書いてあるので、
 * 本体の自己検査が壊れていても検出できる。
 */
function canonical(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(canonical);
  const out = {};
  for (const key of Object.keys(node).sort()) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (node[key] === undefined) continue;
    out[key] = node[key] instanceof RegExp ? String(node[key]) : canonical(node[key]);
  }
  return out;
}

function astJson(code) {
  return JSON.stringify(canonical(parse(code)));
}

function stringLiterals(code) {
  const found = new Set();
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Literal' && typeof n.value === 'string') found.add(n.value);
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'range') continue;
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(parse(code));
  return found;
}

/** node で走らせて stdout と終了コードを取る。stdin フィクスチャがあれば与える。 */
function run(file, stdinFile, timeout) {
  const input = stdinFile && fs.existsSync(stdinFile) ? fs.readFileSync(stdinFile) : Buffer.alloc(0);
  try {
    const stdout = execFileSync(process.execPath, [file], {
      input,
      timeout: timeout || BEHAVE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { code: 0, stdout: stdout.toString(), timedOut: false };
  } catch (err) {
    return {
      code: err.status === undefined || err.status === null ? -1 : err.status,
      stdout: err.stdout ? err.stdout.toString() : '',
      timedOut: Boolean(err.killed) || err.signal === 'SIGTERM',
      error: err.message
    };
  }
}

function writeTmp(name, code) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, name);
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------

function checkSample(configName, obfFile) {
  const checks = [];
  const fail = (name, msg) => checks.push({ name, ok: false, msg });
  const pass = (name) => checks.push({ name, ok: true });

  const base = path.basename(obfFile).replace(/\.obf\.js$/, ''); // 例 01-es5-basic.s1
  const srcBase = base.replace(/\.s\d+$/, '');
  const srcFile = path.join(SRC_DIR, srcBase + '.js');
  const inFile = path.join(path.dirname(obfFile), base + '.obf.in');
  const goldFile = path.join(path.dirname(obfFile), base + '.gold.js');

  const obfCode = fs.readFileSync(obfFile, 'utf8');

  // [strip]
  let result;
  try {
    result = stripCodeCompact(obfCode);
  } catch (err) {
    return { base, checks: [{ name: 'strip', ok: false, msg: err.message.split('\n')[0] }] };
  }
  if (!result.changed) {
    return { base, checks: [{ name: 'strip', ok: false, msg: 'code-compact を検出できなかった' }] };
  }
  pass('strip');

  const out = result.code;

  // [parse]
  try {
    parse(out);
    pass('parse');
  } catch (err) {
    fail('parse', err.message);
    return { base, checks };
  }

  // [gold] 難読化器自身が compact:false で出すコードとバイト一致
  if (GOLD_CONFIGS.has(configName)) {
    if (!fs.existsSync(goldFile)) {
      fail('gold', 'gold ファイルが無い');
    } else {
      const gold = fs.readFileSync(goldFile, 'utf8');
      if (out === gold) pass('gold');
      else fail('gold', `バイト不一致 出力 ${out.length} B / 正解 ${gold.length} B`);
    }
  }

  // [ast] 入力と出力の AST が完全一致（他 6 変換に触れていない証明）
  if (astJson(obfCode) === astJson(out)) pass('ast');
  else fail('ast', '整形前後で AST が変わっている');

  // [multiline] 実際に解除された
  if (out.split('\n').length > 1) pass('multiline');
  else fail('multiline', '出力が 1 行のまま');

  // [idem] もう一度掛けると「対象なし」になり 1 バイトも変わらない
  try {
    const second = stripCodeCompact(out);
    if (second.changed) fail('idem', '2 回目も「解除対象あり」と判定された');
    else if (second.code !== out) fail('idem', '2 回目の適用で出力が変わった');
    else pass('idem');
  } catch (err) {
    fail('idem', err.message.split('\n')[0]);
  }

  // [marks] 他の層の目印が残っている（seven 構成のみ）
  if (configName === 'seven') {
    const lits = stringLiterals(out);
    const absent = [];
    for (const [layer, marks] of Object.entries(LAYER_MARKS)) {
      if (!marks.some((m) => lits.has(m))) absent.push(layer);
    }
    if (absent.length === 0) pass('marks');
    else fail('marks', `${absent.join(' / ')} の目印が消えている`);
  }

  const hasSrc = fs.existsSync(srcFile);
  const rSrc = hasSrc ? run(srcFile, inFile) : null;
  const rObf = run(obfFile, inFile);

  const sameAs = (r) => {
    const okObf = rObf.stdout === r.stdout && rObf.code === r.code;
    const okSrc = !hasSrc || (rSrc.stdout === r.stdout && rSrc.code === r.code);
    return { okObf, okSrc };
  };
  const describeRun = (label, r) =>
    `${hasSrc ? `src(${rSrc.code}) / ` : ''}obf(${rObf.code}) / ${label}(${r.code}${r.timedOut ? ' timeout' : ''})`;

  if (configName === 'seven') {
    // [trap] 既定の出力は self-defending が発火して実行がタイムアウトする
    const trapFile = writeTmp(`${configName}.${base}.plain.js`, out);
    const rTrap = run(trapFile, inFile, TRAP_TIMEOUT_MS);
    if (rTrap.timedOut) pass('trap');
    else fail('trap', `ハングしなかった（code=${rTrap.code}）。self-defending が効いていない可能性`);

    // [guard] --keep-self-defending なら動く
    let kept;
    try {
      kept = stripCodeCompact(obfCode, { keepSelfDefending: true });
    } catch (err) {
      fail('guard', err.message.split('\n')[0]);
      return { base, checks };
    }
    if (kept.code.split('\n').length <= 1) {
      fail('guard', '保護モードの出力が 1 行のまま');
      return { base, checks };
    }
    if (astJson(obfCode) !== astJson(kept.code)) {
      fail('guard', '保護モードで AST が変わっている');
      return { base, checks };
    }
    const guardFile = writeTmp(`${configName}.${base}.guard.js`, kept.code);
    const rGuard = run(guardFile, inFile);
    const { okObf, okSrc } = sameAs(rGuard);
    if (okObf && okSrc) pass('guard');
    else fail('guard', `${describeRun('guard', rGuard)} stdout一致 obf=${rObf.stdout === rGuard.stdout}`);
  } else {
    // [behave] 原本・難読化後・解除後で stdout と終了コードが一致
    const outFile = writeTmp(`${configName}.${base}.decompact.js`, out);
    const rOut = run(outFile, inFile);
    const { okObf, okSrc } = sameAs(rOut);
    if (okObf && okSrc) pass('behave');
    else fail('behave', `${describeRun('decompact', rOut)} stdout一致 obf=${rObf.stdout === rOut.stdout}`);
  }

  return { base, checks };
}

// ---------------------------------------------------------------------------

function verifyNoop() {
  // [noop] 既に整形済みのコード（= 難読化器の compact:false 出力）を素通しする
  const rows = [];
  for (const configName of GOLD_CONFIGS) {
    const dir = path.join(OBF_DIR, configName);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.gold.js')).sort()) {
      const code = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        const r = stripCodeCompact(code);
        const ok = !r.changed && r.code === code;
        rows.push({
          base: `${configName}/${f}`,
          checks: [{ name: 'noop', ok, msg: ok ? '' : r.changed ? '整形済みなのに解除対象と判定された' : '入力が改変された' }]
        });
      } catch (err) {
        rows.push({ base: `${configName}/${f}`, checks: [{ name: 'noop', ok: false, msg: err.message.split('\n')[0] }] });
      }
    }
  }
  return rows;
}

function verifyPlainSources() {
  // [nontarget] 難読化していないコードを入れても何も壊さない
  const rows = [];
  for (const f of fs.readdirSync(SRC_DIR).filter((x) => x.endsWith('.js')).sort()) {
    const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    try {
      const r = stripCodeCompact(code);
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
    console.log(`  [${mark}] ${row.base.padEnd(40)} ${names}`);
    for (const b of bad) console.log(`         ${b.name}: ${b.msg}`);
    if (bad.length > 0) failed += 1;
  }
  console.log(`  -- ${rows.length - failed}/${rows.length} PASS`);
  return failed;
}

function main() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  let failed = 0;

  for (const configName of ['compact-only', 'six-nosd', 'seven']) {
    const dir = path.join(OBF_DIR, configName);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.obf.js'))
      .sort()
      .map((f) => path.join(dir, f));
    failed += report(`${configName} (${files.length} サンプル)`, files.map((f) => checkSample(configName, f)));
  }

  failed += report('整形済み入力 — 素通しすること', verifyNoop());
  failed += report('非対象入力 — 難読化していないコードを壊さないこと', verifyPlainSources());

  console.log(`\n${failed === 0 ? '全項目 PASS' : `${failed} 件の失敗`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
