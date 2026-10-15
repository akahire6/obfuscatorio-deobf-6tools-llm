#!/usr/bin/env node
'use strict';

/**
 * verify.js — strip-debug-protection.js の自動検証。
 *
 * testdata/obf/ の各サンプル（gen-corpus.js が新規に生成したもの。
 * JsDeObsBench のデータセットは使わない）について次を確かめる:
 *
 *   [strip]   debug-protection を検出して解除できた
 *   [parse]   出力が JS としてパースできる
 *   [residue] 削除した部品の宣言が 1 つも残っていない
 *   [idem]    もう一度掛けると「対象なし」で、1 バイトも変わらない
 *   [layers]  除去した部品以外はノードが 1 つも変わっていない
 *             （畳み込みをしないので全ノード種別で厳密等式が成立する。
 *               = 他 6 変換に触れていないことの機械的な証明）
 *   [frozen]  生き残った文の生成バイト列が完全一致（ノード数だけでなく中身も不変）
 *   [strings] 文字列配列関数・デコーダ・ローテータがバイト単位で不変
 *             （= string-obfuscation 層に指一本触れていない）
 *   [marks]   self-defending の目印と 16 進識別子が残っている
 *   [compact] 入力が 1 行なら出力も 1 行（= code-compact を解除していない）
 *   [nodebug] 難読化コードでは debugger 生成が起きるのに、解除後は一度も起きない
 *             （この層が本当に消えたことの動的な証明。spy-preload.js を使う）
 *   [behave]  原本・難読化後・解除後の 3 つが同じ stdout / 終了コードを返す
 *
 * さらに 2 種類の負例を見る:
 *   no-debug   debug-protection 以外の 6 変換 → 1 バイトも変えてはいけない
 *   hard       デコーダを組めない設定 + debug-protection
 *              → 黙って素通しせず、理由つきで失敗しなければいけない
 *   素のソース  難読化していないコード → 1 バイトも変えてはいけない
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const { stripDebugProtection } = require('./strip-debug-protection.js');
const destring = require('../destring/strip-string-obfuscation.js');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'testdata', 'src');
const OBF_DIR = path.join(ROOT, 'testdata', 'obf');
const TMP_DIR = path.join(ROOT, 'testdata', '.verify-tmp');
const SPY = path.join(ROOT, 'spy-preload.js');

const PARSER_OPTIONS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true
};

/** 他の層が残っていることの目印。設定ごとに何が残るはずかが違う。 */
const LAYER_MARKS = {
  seven: [
    { name: 'self-defending', re: /\(\(\(\.\+\)\+\)\+\)\+\$|\['search'\]|\[_0x[0-9a-f]+\(0x[0-9a-f]+\)\]/ },
    { name: 'hex 識別子', re: /_0x[0-9a-f]{4,}/ },
    { name: 'string-array', re: /parseInt/ }
  ],
  'debug-interval': [
    { name: 'hex 識別子', re: /_0x[0-9a-f]{4,}/ },
    { name: 'string-array', re: /parseInt/ }
  ],
  'debug-only': []
};

// ---------------------------------------------------------------------------

function typeHistogram(nodes) {
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
  nodes.forEach(visit);
  return counts;
}

function histogram(code) {
  return typeHistogram([parser.parse(code, PARSER_OPTIONS).program]);
}

/** すべての文（Program 直下と各ブロック直下）の生成バイト列を多重集合として取る。 */
function statementBytes(code) {
  const ast = parser.parse(code, PARSER_OPTIONS);
  const out = new Map();
  const add = (s) => out.set(s, (out.get(s) || 0) + 1);
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (t.isProgram(n) || t.isBlockStatement(n)) {
      for (const stmt of n.body) add(generate(stmt, { compact: true }).code);
    }
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast.program);
  return out;
}

/** 名前ごとの「宣言の個数」を数える（同名シャドーイングを取り違えないため）。 */
function declarationCounts(code) {
  const ast = parser.parse(code, PARSER_OPTIONS);
  const counts = new Map();
  const bump = (name) => counts.set(name, (counts.get(name) || 0) + 1);
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (t.isFunctionDeclaration(n) && n.id) bump(n.id.name);
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) bump(n.id.name);
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast.program);
  return counts;
}

/** string-obfuscation の 3 部品のソースを取り出す（バイト比較用）。 */
function stringArrayParts(code) {
  const ast = parser.parse(code, PARSER_OPTIONS);
  const parts = [];
  let arrayName = null;

  for (const stmt of ast.program.body) {
    const m = destring.matchStringArrayFunction(stmt);
    if (m) {
      arrayName = m.name;
      parts.push(generate(stmt, { compact: true }).code);
    }
  }
  if (!arrayName) return null;

  for (const stmt of ast.program.body) {
    if (destring.matchDecoderFunction(stmt, arrayName)) {
      parts.push(generate(stmt, { compact: true }).code);
    }
    if (destring.matchRotatorStatement(stmt, arrayName)) {
      parts.push(generate(stmt, { compact: true }).code);
    }
  }
  return parts.sort().join('\n');
}

/**
 * spy-preload.js を噛ませて子プロセスで走らせ、stdout / 終了コードと
 * debugger 生成の回数を同時に取る。
 */
function runWithSpy(file, stdinFile) {
  const r = spawnSync(process.execPath, ['-r', SPY, file], {
    input: stdinFile ? fs.readFileSync(stdinFile) : '',
    encoding: 'utf8',
    timeout: 60000
  });

  let spy = { dbg: 0, wt: 0, iv: 0 };
  const stderr = r.stderr || '';
  const m = stderr.match(/__DEDEBUG_SPY__(\{.*\})/);
  if (m) {
    try {
      spy = JSON.parse(m[1]);
    } catch (_) {
      /* 壊れていたら既定値のまま。判定側で「観測できなかった」として扱う */
    }
  }

  return {
    code: r.status === null ? -1 : r.status,
    out: r.stdout || '',
    timedOut: r.error && r.error.code === 'ETIMEDOUT',
    spy,
    sawMarker: Boolean(m)
  };
}

// ---------------------------------------------------------------------------

function checkSample(configName, obfFile) {
  const checks = [];
  const fail = (name, msg) => checks.push({ name, ok: false, msg });
  const pass = (name) => checks.push({ name, ok: true });

  const base = path.basename(obfFile, '.obf.js');
  const srcBase = base.replace(/\.s\d+$/, '');
  const obfCode = fs.readFileSync(obfFile, 'utf8');
  const srcFile = path.join(SRC_DIR, srcBase + '.js');
  const stdinFile = path.join(path.dirname(obfFile), base + '.obf.in');
  const stdin = fs.existsSync(stdinFile) ? stdinFile : null;

  let result;
  try {
    result = stripDebugProtection(obfCode, {});
  } catch (err) {
    return { base, checks: [{ name: 'strip', ok: false, msg: err.message.split('\n')[0] }] };
  }
  if (!result.changed) {
    return { base, checks: [{ name: 'strip', ok: false, msg: 'debug-protection を検出できなかった' }] };
  }
  pass('strip');

  // --- parse ---
  try {
    parser.parse(result.code, PARSER_OPTIONS);
    pass('parse');
  } catch (err) {
    fail('parse', err.message.split('\n')[0]);
    return { base, checks };
  }

  // --- residue: 削除した部品の宣言がちょうど 1 つ減っていること ---
  // 難読化器はデコーダのローカル変数に DPF と同じ名前を割り当てることがあるので、
  // 名前の出現ではなく「その名前の宣言の個数」を AST で数える。
  try {
    const before = declarationCounts(obfCode);
    const after = declarationCounts(result.code);
    const expect = new Map();
    expect.set(result.stats.debugProtectionFunction, 1);
    if (result.stats.controller && !result.stats.controllerShared) {
      expect.set(result.stats.controller, (expect.get(result.stats.controller) || 0) + 1);
    }
    const bad = [];
    for (const [name, n] of expect) {
      // 部分木ごと消すので、同じ名前の内側の宣言も一緒に減ることがある。
      // 少なくとも期待した数だけ減っていればよい。
      const diff = (before.get(name) || 0) - (after.get(name) || 0);
      if (diff < n) bad.push(`${name}: ${diff} 個しか減っていない（期待 ${n} 以上）`);
    }
    if (bad.length === 0) pass('residue');
    else fail('residue', bad.join(' / '));
  } catch (err) {
    fail('residue', err.message.split('\n')[0]);
  }

  // --- idem ---
  try {
    const again = stripDebugProtection(result.code, {});
    if (again.changed) fail('idem', '2 回目も何かを剥がした');
    else if (again.code !== result.code) fail('idem', '2 回目で出力が変わった');
    else pass('idem');
  } catch (err) {
    fail('idem', err.message.split('\n')[0]);
  }

  // --- layers: 難読化後 − 除去分 = 解除後 が全ノード種別で厳密に成立すること ---
  // 畳み込みを一切しないので、許容リストを設けず全種別で等式を要求できる。
  // デッドコードの分岐や CFF 辞書を 1 つでも触っていればここで破れる。
  try {
    const before = histogram(obfCode);
    const after = histogram(result.code);
    const removedCounts = result.stats.removedTypeCounts || {};
    const types = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(removedCounts)]);
    const drift = [];
    for (const ty of types) {
      const expected = (before[ty] || 0) - (removedCounts[ty] || 0);
      const actual = after[ty] || 0;
      if (expected !== actual) drift.push(`${ty}: 期待 ${expected} 実際 ${actual}`);
    }
    if (drift.length === 0) pass('layers');
    else fail('layers', drift.slice(0, 4).join(' / '));
  } catch (err) {
    fail('layers', err.message.split('\n')[0]);
  }

  // --- frozen: 触っていない文はバイト単位で不変 ---
  // 削除した文を「含んでいた」祖先の文は当然テキストが変わるので、
  // 出力側の文のうち入力に無いものの個数が、削除した文の親の個数以下であることを見る。
  // （= 変化が削除箇所の周りだけに閉じている）
  try {
    const before = statementBytes(obfCode);
    const after = statementBytes(result.code);
    const appeared = [];
    for (const [code, n] of after) {
      if ((before.get(code) || 0) < n) appeared.push(code);
    }
    const limit = result.stats.bootstrapStatements + 2; // DPF / controller / 起動部 の親
    if (appeared.length <= limit) pass('frozen');
    else fail('frozen', `変化した文が ${appeared.length} 個（許容 ${limit}）: ${appeared[0].slice(0, 60)}`);
  } catch (err) {
    fail('frozen', err.message.split('\n')[0]);
  }

  // --- strings: string-obfuscation の 3 部品がバイト単位で不変 ---
  try {
    const b = stringArrayParts(obfCode);
    const a = stringArrayParts(result.code);
    if (b === a) pass('strings');
    else fail('strings', '文字列配列まわりが変わっている');
  } catch (err) {
    fail('strings', err.message.split('\n')[0]);
  }

  // --- marks: 他の層の目印が残っている ---
  const marks = LAYER_MARKS[configName] || [];
  const lost = marks.filter((m) => !m.re.test(result.code));
  if (lost.length === 0) pass('marks');
  else fail('marks', `消えた目印: ${lost.map((m) => m.name).join(', ')}`);

  // --- compact ---
  const inLines = obfCode.trim().split('\n').length;
  const outLines = result.code.trim().split('\n').length;
  if (inLines > 1 || outLines === 1) pass('compact');
  else fail('compact', `1 行の入力が ${outLines} 行になった`);

  // --- nodebug / behave: 子プロセスで 3 つ走らせる ---
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outFile = path.join(TMP_DIR, base + '.stripped.js');
    fs.writeFileSync(outFile, result.code, 'utf8');

    const rSrc = runWithSpy(srcFile, stdin);
    const rObf = runWithSpy(obfFile, stdin);
    const rOut = runWithSpy(outFile, stdin);

    // nodebug
    if (!rObf.sawMarker || !rOut.sawMarker) {
      fail('nodebug', 'スパイの集計を受け取れなかった');
    } else if (rObf.spy.dbg <= rSrc.spy.dbg) {
      fail('nodebug', '難読化コードで debugger 生成を観測できなかった（検査が空振りしている）');
    } else if (
      rOut.spy.dbg > rSrc.spy.dbg ||
      rOut.spy.wt > rSrc.spy.wt ||
      rOut.spy.iv > rSrc.spy.iv
    ) {
      // 原本を基準にする。ユーザプログラム自身が setInterval や
      // new Function を使っていても誤検出しない。
      fail(
        'nodebug',
        `解除後 debugger=${rOut.spy.dbg} whileTrue=${rOut.spy.wt} setInterval=${rOut.spy.iv} ` +
          `／原本 debugger=${rSrc.spy.dbg} whileTrue=${rSrc.spy.wt} setInterval=${rSrc.spy.iv}`
      );
    } else if (rObf.spy.wt > 0) {
      fail('nodebug', `難読化コード側で改竄検知の罠が発火した (whileTrue=${rObf.spy.wt})`);
    } else {
      pass('nodebug');
    }

    // behave
    const sameOut = rSrc.out === rObf.out && rSrc.out === rOut.out;
    const sameCode = rSrc.code === rObf.code && rSrc.code === rOut.code;
    if (sameOut && sameCode) pass('behave');
    else {
      fail(
        'behave',
        `exit src=${rSrc.code} obf=${rObf.code} out=${rOut.code} / ` +
          `stdout obf=${rSrc.out === rObf.out} out=${rSrc.out === rOut.out}`
      );
    }
  } catch (err) {
    fail('behave', err.message.split('\n')[0]);
  }

  return { base, checks };
}

/** 1 バイトも変えてはいけない入力。 */
function verifyUnchanged(dir, ext) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => {
      const code = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        const r = stripDebugProtection(code, {});
        const ok = !r.changed && r.code === code;
        return { base: f, checks: [{ name: 'nontarget', ok, msg: ok ? '' : '入力が改変された' }] };
      } catch (err) {
        return { base: f, checks: [{ name: 'nontarget', ok: false, msg: err.message.split('\n')[0] }] };
      }
    });
}

/** 理由つきで失敗しなければいけない入力。 */
function verifyRefused(dir, ext) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => {
      const code = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        const r = stripDebugProtection(code, {});
        return {
          base: f,
          checks: [
            {
              name: 'refuse',
              ok: false,
              msg: r.changed ? '未対応の設定なのに解除してしまった' : '未対応の設定を黙って素通しした'
            }
          ]
        };
      } catch (err) {
        const ok = err.name === 'StripError';
        return { base: f, checks: [{ name: 'refuse', ok, msg: ok ? '' : `想定外の例外: ${err.message}` }] };
      }
    });
}

function report(title, rows) {
  console.log(`\n== ${title}`);
  let failed = 0;
  for (const row of rows) {
    const bad = row.checks.filter((c) => !c.ok);
    const mark = bad.length === 0 ? 'PASS' : 'FAIL';
    const names = row.checks.map((c) => (c.ok ? c.name : `${c.name}!`)).join(' ');
    console.log(`  [${mark}] ${row.base}  ${names}`);
    for (const b of bad) console.log(`         ${b.name}: ${b.msg}`);
    if (bad.length > 0) failed += 1;
  }
  console.log(`  -- ${rows.length - failed}/${rows.length} PASS`);
  return failed;
}

function main() {
  if (!fs.existsSync(OBF_DIR)) {
    console.error('testdata/obf/ が無い。先に node gen-corpus.js を実行すること。');
    process.exit(2);
  }

  let failed = 0;

  for (const configName of ['seven', 'debug-only', 'debug-interval']) {
    const dir = path.join(OBF_DIR, configName);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.obf.js')).sort();
    failed += report(
      `${configName} (${files.length} サンプル)`,
      files.map((f) => checkSample(configName, path.join(dir, f)))
    );
  }

  failed += report(
    'no-debug（負例: 他 6 変換だけ。無変更であるべき）',
    verifyUnchanged(path.join(OBF_DIR, 'no-debug'), '.obf.js')
  );
  failed += report(
    'hard（負例: 未対応の設定。理由つきで失敗すべき）',
    verifyRefused(path.join(OBF_DIR, 'hard'), '.obf.js')
  );
  failed += report('素のソース（非対象入力。無変更であるべき）', verifyUnchanged(SRC_DIR, '.js'));

  console.log(`\n${failed === 0 ? '全項目 PASS' : `${failed} 件の失敗`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
