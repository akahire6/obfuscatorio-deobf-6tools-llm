#!/usr/bin/env node
'use strict';

/**
 * verify.js — strip-control-flow-flattening.js の自動検証。
 *
 * testdata/obf/ の各サンプル（gen-corpus.js が新規に生成したもの。
 * JsDeObsBench のデータセットは使わない）について次を確かめる:
 *
 *   [strip]     control-flow-flattening を検出して解除できた
 *   [parse]     出力が JS としてパースできる
 *   [ledger]    全ノード種別で 入力 − 除去 + 追加 = 出力（台帳に無い改変がゼロ）
 *   [frozen]    CFF で動くはずのない種別が 1 つも増減していない
 *               （IfStatement が不変 = deadcode-injection 層が保存されている証明）
 *   [str-array] 文字列配列の中身が入出力でバイト一致（順序含む）
 *   [str-parts] 配列関数・デコーダ・ローテータの生成コードがバイト一致
 *   [str-nonew] 出力に新しい文字列が 1 つも現れない
 *               （= 文字列層を「読んだ」だけで「書き戻していない」証明）
 *   [names]     出力に新しい識別子名が 1 つも現れない（name-obfuscation 不変）
 *   [cff-gone]  storage 辞書もディスパッチャも残っていない
 *   [compact]   入力が 1 行なら出力も 1 行（= code-compact を解除していない）
 *   [residue]   もう一度掛けると「対象なし」になる（= 残骸ゼロ）
 *   [idem]      2 回目の適用で 1 バイトも変わらない
 *   [marks]     self-defending / debug-protection の目印が残っている（seven のみ）
 *   [behave]    原本・難読化後・解除後の 3 つが同じ stdout と終了コードを返す
 *
 * さらに負例として:
 *   no-cff     CFF が掛かっていないので 1 バイトも変えないこと（誤検出ゼロ）
 *   cff-hard   デコーダを組み立てられない設定。理由つきで失敗すること
 *   非対象入力 難読化していないコードを壊さないこと
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const destring = require('../destring/strip-string-obfuscation.js');
const {
  stripControlFlowFlattening,
  StripError,
  typeHistogram,
  collectStorages,
  buildStringLayerContext,
  matchDispatcher
} = require('./strip-control-flow-flattening.js');
const traverse = require('@babel/traverse').default;

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
 * CFF の解除では動かないノード種別。
 * storage の畳み込みは CallExpression / MemberExpression / Identifier / リテラル /
 * ObjectExpression / FunctionExpression を動かし、switch 展開は
 * Switch / While / Break / Continue / Array / Unary / Update を減らす。
 * それ以外の制御構造は 1 つも増減してはいけない。
 * ★ IfStatement が不変であることが deadcode-injection 層の保存の直接証明
 *   （S['K']('a', S['L']) を畳むと 'a'==='a' になるが、定数畳み込みはしないので if は残る）。
 */
const FROZEN_TYPES = [
  'IfStatement',
  'ConditionalExpression',
  'TryStatement',
  'CatchClause',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'DoWhileStatement',
  'ThrowStatement',
  'DebuggerStatement',
  'LabeledStatement',
  'ClassDeclaration',
  'ClassExpression',
  'ObjectMethod',
  'FunctionDeclaration',
  'ArrowFunctionExpression',
  'TemplateLiteral',
  'TaggedTemplateExpression',
  'RegExpLiteral',
  'NewExpression',
  'AwaitExpression',
  'YieldExpression'
];

/** self-defending / debug-protection が残っていることの目印 */
const LAYER_MARKS = {
  'self-defending': ['(((.+)+)+)+$'],
  'debug-protection': ['function *\\( *\\)', 'while (true) {}']
};

// ---------------------------------------------------------------------------

function parse(code) {
  return parser.parse(code, PARSER_OPTIONS);
}

function histogram(code) {
  return typeHistogram([parse(code).program]);
}

/** コード中の文字列リテラル値の集合 */
function stringLiterals(code) {
  const ast = parse(code);
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

/** コード中の識別子名の集合 */
function identifierNames(code) {
  const ast = parse(code);
  const found = new Set();
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (t.isIdentifier(n)) found.add(n.name);
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast.program);
  return found;
}

/**
 * 文字列層の 3 部品を取り出して、生成コードと配列の中身を返す。
 * 入出力で突き合わせて「文字列層に一切触れていない」ことを見るため。
 */
function stringLayerFingerprint(code) {
  const ast = parse(code);

  let arrayFn = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (arrayFn) return;
      const m = destring.matchStringArrayFunction(p.node);
      if (m) arrayFn = { ...m, node: p.node };
    }
  });
  if (!arrayFn) return { present: false };

  let decoderFn = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (decoderFn) return;
      const m = destring.matchDecoderFunction(p.node, arrayFn.name);
      if (m) decoderFn = { ...m, node: p.node };
    }
  });

  let rotator = null;
  traverse(ast, {
    ExpressionStatement(p) {
      if (rotator) return;
      if (destring.matchRotatorStatement(p.node, arrayFn.name)) rotator = p.node;
    }
  });

  const gen = (n) => (n ? generate(n, { compact: true }).code : null);
  return {
    present: true,
    strings: arrayFn.strings,
    arrayCode: gen(arrayFn.node),
    decoderCode: gen(decoderFn ? decoderFn.node : null),
    rotatorCode: gen(rotator)
  };
}

/**
 * 残った storage が「デッドコードの中の、解決しようのないコピー」か。
 *
 * deadcode-injection は control-flow-flattening の後段で走るので、死んだ分岐に
 * storage のコピーが紛れ込む。そのコピーは他所の辞書へ委譲しているが、委譲先の
 * 名前はその場所では束縛されていない（別の関数から持ってきた断片なので）。
 * 委譲先が解決できない以上、畳みようがない。展開せず残すのが挙動保存的に正しい。
 */
function isUnresolvableDeadCopy(storage) {
  let found = false;
  const scope = storage.declPath.scope;
  const visit = (n) => {
    if (found || !n || typeof n.type !== 'string') return;
    if (t.isMemberExpression(n) && t.isIdentifier(n.object) && !scope.getBinding(n.object.name)) {
      found = true;
      return;
    }
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(storage.declPath.node.init);
  return found;
}

/** 出力に CFF の痕跡が残っていないか（storage / ディスパッチャ） */
function cffResidue(code) {
  const ast = parse(code);
  let programScope = null;
  traverse(ast, {
    Program(p) {
      programScope = p.scope;
      p.stop();
    }
  });

  let ctx = null;
  try {
    ctx = buildStringLayerContext(ast, programScope, 5000);
  } catch (_) {
    ctx = null;
  }

  const all = [...collectStorages(ast, ctx, {}).values()];
  const dead = all.filter(isUnresolvableDeadCopy);
  const storages = { size: all.length - dead.length, dead: dead.length };

  let dispatchers = 0;
  const stats = { skipped: { unreadableOrder: 0 } };
  traverse(ast, {
    WhileStatement(p) {
      if (matchDispatcher(p, ctx, stats)) dispatchers += 1;
    }
  });

  return {
    storages: storages.size,
    deadCopies: storages.dead,
    dispatchers,
    unreadableOrder: stats.skipped.unreadableOrder
  };
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

  const base = path.basename(obfFile).replace(/\.obf\.js$/, ''); // 例 13-cff-var-block.s1
  const srcBase = base.replace(/\.s\d+$/, '');
  const srcFile = path.join(SRC_DIR, srcBase + '.js');
  const inFile = path.join(SRC_DIR, srcBase + '.in');

  const obfCode = fs.readFileSync(obfFile, 'utf8');

  let result;
  try {
    result = stripControlFlowFlattening(obfCode);
  } catch (err) {
    return { base, checks: [{ name: 'strip', ok: false, msg: err.message.split('\n')[0] }] };
  }

  if (!result.changed) {
    return { base, checks: [{ name: 'strip', ok: false, msg: 'CFF を検出できなかった' }] };
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

  // [ledger] 全ノード種別で 入力 − 除去 + 追加 = 出力
  const hIn = histogram(obfCode);
  const hOut = histogram(out);
  const rem = result.removedTypeCounts;
  const add = result.addedTypeCounts;
  const allTypes = new Set([
    ...Object.keys(hIn),
    ...Object.keys(hOut),
    ...Object.keys(rem),
    ...Object.keys(add)
  ]);
  const drift = [];
  for (const type of allTypes) {
    const expected = (hIn[type] || 0) - (rem[type] || 0) + (add[type] || 0);
    const actual = hOut[type] || 0;
    if (expected !== actual) drift.push(`${type}: 期待 ${expected} / 実際 ${actual}`);
  }
  if (drift.length === 0) pass('ledger');
  else fail('ledger', drift.slice(0, 4).join(', '));

  // [frozen] CFF で動くはずのない種別が増減していない
  const frozenDrift = [];
  for (const type of FROZEN_TYPES) {
    const a = hIn[type] || 0;
    const b = hOut[type] || 0;
    if (a !== b) frozenDrift.push(`${type}: ${a} -> ${b}`);
  }
  if (frozenDrift.length === 0) pass('frozen');
  else fail('frozen', frozenDrift.join(', '));

  // [str-array] [str-parts] 文字列層が 1 バイトも変わっていない
  const fIn = stringLayerFingerprint(obfCode);
  const fOut = stringLayerFingerprint(out);
  if (fIn.present) {
    if (!fOut.present) {
      fail('str-array', '出力から文字列配列関数が消えた');
    } else if (fIn.strings.length !== fOut.strings.length) {
      fail('str-array', `配列長が ${fIn.strings.length} -> ${fOut.strings.length} に変わった`);
    } else {
      const bad = fIn.strings.findIndex((s, i) => s !== fOut.strings[i]);
      if (bad >= 0) fail('str-array', `配列の ${bad} 番目が変わった`);
      else pass('str-array');
    }

    if (fOut.present) {
      const partDrift = [];
      if (fIn.arrayCode !== fOut.arrayCode) partDrift.push('配列関数');
      if (fIn.decoderCode !== fOut.decoderCode) partDrift.push('デコーダ');
      if (fIn.rotatorCode !== fOut.rotatorCode) partDrift.push('ローテータ');
      if (partDrift.length === 0) pass('str-parts');
      else fail('str-parts', `${partDrift.join(' / ')} が変わった`);
    }
  }

  // [str-nonew] 出力に新しい文字列が 1 つも現れない
  const litsIn = stringLiterals(obfCode);
  const litsOut = stringLiterals(out);
  const newLits = [...litsOut].filter((s) => !litsIn.has(s));
  if (newLits.length === 0) pass('str-nonew');
  else fail('str-nonew', `新しい文字列が ${newLits.length} 件 例: ${JSON.stringify(newLits.slice(0, 3))}`);

  // [names] 出力に新しい識別子名が 1 つも現れない
  const idIn = identifierNames(obfCode);
  const idOut = identifierNames(out);
  const newIds = [...idOut].filter((s) => !idIn.has(s));
  if (newIds.length === 0) pass('names');
  else fail('names', `新しい識別子が ${newIds.length} 件 例: ${JSON.stringify(newIds.slice(0, 3))}`);

  // [cff-gone] storage もディスパッチャも残っていない
  const residue = cffResidue(out);
  if (residue.storages === 0 && residue.dispatchers === 0) pass('cff-gone');
  else fail('cff-gone', `storage ${residue.storages} 件 / ディスパッチャ ${residue.dispatchers} 件が残存`);

  // [compact] 入力が 1 行なら出力も 1 行
  if (!obfCode.trimEnd().includes('\n')) {
    if (out.trimEnd().includes('\n')) fail('compact', `出力に改行が ${out.trimEnd().split('\n').length - 1} 個ある`);
    else pass('compact');
  }

  // [residue] [idem]
  let second = null;
  try {
    second = stripControlFlowFlattening(out);
    if (second.changed) fail('residue', 'CFF 部品がまだ残っている');
    else pass('residue');
  } catch (err) {
    fail('residue', err.message.split('\n')[0]);
  }
  if (second && !second.changed) {
    if (second.code === out) pass('idem');
    else fail('idem', '2 回目の適用で出力が変わった');
  }

  // [marks] 他の層の目印が残っている（seven 構成のみ）
  if (configName === 'seven') {
    const absent = [];
    for (const [layer, marks] of Object.entries(LAYER_MARKS)) {
      if (!marks.some((m) => litsOut.has(m))) absent.push(layer);
    }
    if (absent.length === 0) pass('marks');
    else fail('marks', `${absent.join(' / ')} の目印が消えている`);
  }

  // [behave] 原本・難読化後・解除後で stdout と終了コードが一致
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outFile = path.join(TMP_DIR, `${configName}.${base}.decff.js`);
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
      `${hasSrc ? `src(${rSrc.code}) / ` : ''}obf(${rObf.code}) / decff(${rOut.code}) ` +
        `stdout一致 obf=${rObf.stdout === rOut.stdout}${hasSrc ? ` src=${rSrc.stdout === rOut.stdout}` : ''}` +
        (rOut.error ? ` err=${rOut.error.split('\n')[0]}` : '')
    );
  }

  return { base, checks, stats: result.stats };
}

// ---------------------------------------------------------------------------

/** 負例: CFF が掛かっていない構成。1 バイトも変えてはいけない。 */
function checkUntouched(configName, obfFile) {
  const base = path.basename(obfFile).replace(/\.obf\.js$/, '');
  const code = fs.readFileSync(obfFile, 'utf8');
  try {
    const r = stripControlFlowFlattening(code);
    if (!r.changed && r.code === code) return { base, checks: [{ name: 'untouched', ok: true }] };
    return {
      base,
      checks: [{ name: 'untouched', ok: false, msg: r.changed ? 'CFF でないものを解除した' : '出力が変わった' }]
    };
  } catch (err) {
    return { base, checks: [{ name: 'untouched', ok: false, msg: err.message.split('\n')[0] }] };
  }
}

/** 負例: デコーダを組み立てられない設定。理由つきで失敗すること。 */
function checkRefuse(obfFile) {
  const base = path.basename(obfFile).replace(/\.obf\.js$/, '');
  const code = fs.readFileSync(obfFile, 'utf8');
  try {
    const r = stripControlFlowFlattening(code, { strict: true });
    // 何も検出せず素通しするのも安全な結果（壊れたコードを出していない）。
    if (!r.changed && r.code === code) return { base, checks: [{ name: 'refuse', ok: true }] };
    return { base, checks: [{ name: 'refuse', ok: false, msg: '壊れているはずの入力を書き換えた' }] };
  } catch (err) {
    if (err instanceof StripError) return { base, checks: [{ name: 'refuse', ok: true }] };
    return { base, checks: [{ name: 'refuse', ok: false, msg: `StripError 以外: ${err.message.split('\n')[0]}` }] };
  }
}

/** 非対象入力: 難読化していないコードを壊さないこと。 */
function checkPlainSources() {
  const results = [];
  for (const f of fs.readdirSync(SRC_DIR).filter((x) => x.endsWith('.js')).sort()) {
    const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    try {
      const r = stripControlFlowFlattening(code);
      if (!r.changed && r.code === code) results.push({ base: f, checks: [{ name: 'nontarget', ok: true }] });
      else results.push({ base: f, checks: [{ name: 'nontarget', ok: false, msg: '入力が変わった' }] });
    } catch (err) {
      results.push({ base: f, checks: [{ name: 'nontarget', ok: false, msg: err.message.split('\n')[0] }] });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------

function report(title, results) {
  console.log(`\n=== ${title} ===`);
  let passed = 0;
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.ok);
    const tag = bad.length === 0 ? 'PASS' : 'FAIL';
    if (bad.length === 0) passed += 1;
    console.log(`  [${tag}] ${r.base.padEnd(34)} ${r.checks.map((c) => c.name).join(' ')}`);
    for (const b of bad) console.log(`         ${b.name}: ${b.msg}`);
  }
  console.log(`  -- ${passed}/${results.length} PASS`);
  return results.length - passed;
}

function listObf(configName) {
  const dir = path.join(OBF_DIR, configName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.obf.js'))
    .sort()
    .map((f) => path.join(dir, f));
}

function main() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  let failures = 0;

  for (const cfg of ['seven', 'cff-only']) {
    const files = listObf(cfg);
    // CFF が実際に掛かっていないサンプル（ソースが小さい等）は対象外として除く
    const results = [];
    const skipped = [];
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8');
      let r;
      try {
        r = stripControlFlowFlattening(code);
      } catch (err) {
        results.push({ base: path.basename(f), checks: [{ name: 'strip', ok: false, msg: err.message.split('\n')[0] }] });
        continue;
      }
      if (!r.changed) {
        skipped.push(path.basename(f));
        continue;
      }
      results.push(checkSample(cfg, f));
    }
    failures += report(`${cfg} (${results.length} サンプル)`, results);
    if (skipped.length > 0) {
      console.log(`  （CFF 非適用で対象外: ${skipped.length} 件）`);
    }
  }

  failures += report(
    '負例 no-cff — CFF が無い入力を 1 バイトも変えないこと',
    listObf('no-cff').map((f) => checkUntouched('no-cff', f))
  );

  failures += report(
    '負例 cff-hard — 理由つきで失敗すること',
    listObf('cff-hard').map((f) => checkRefuse(f))
  );

  failures += report('非対象入力 — 難読化していないコードを壊さないこと', checkPlainSources());

  console.log(failures === 0 ? '\n全項目 PASS' : `\n${failures} 件 FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
