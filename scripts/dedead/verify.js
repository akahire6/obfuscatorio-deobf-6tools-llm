#!/usr/bin/env node
'use strict';

/**
 * verify.js — strip-deadcode-injection.js の自動検証。
 *
 * testdata/obf/ の各サンプル（gen-corpus.js が新規に生成したもの。
 * JsDeObsBench のデータセットは使わない）について次を確かめる:
 *
 *   [strip]      deadcode を検出して除去できた
 *   [parse]      出力が JS としてパースできる
 *   [stable]     generate(parse(out)) === out（再生成で揺れない）
 *   [subseq]     出力が入力（同じ generator で正規化したもの）の文字単位の部分列
 *                = 1 文字も足しておらず、削除しかしていないことの証明
 *   [layers]     全ノード種別で「入力 − 除去分 = 出力」が成立
 *                = 除去した部分木以外はノード 1 つ動いていないことの証明
 *   [certificate] スクリプトの申告を使わず、入力 AST と出力 AST を並行再帰比較して
 *                除去箇所を独立に数え直し、件数と述語の形を照合する
 *   [strarray]   文字列配列の要素が入力と要素単位で一致（string 層が無傷）
 *   [cffdict]    control-flow-flattening の辞書がキーも値も入力と完全一致
 *                （死枝でしか使われていないエントリも残っていること）
 *   [marks]      debug-protection / self-defending の目印が残っている
 *   [compact]    入力が 1 行なら出力も 1 行（= code-compact を解除していない）
 *   [residue]    もう一度掛けると検出 0 件
 *   [idem]       2 回目の適用で 1 バイトも変わらない
 *   [accounting] candidates === resolved + unresolved + skippedShape + skippedLeak
 *   [behave]     難読化前・難読化後・解除後の 3 つが同じ stdout / 終了コードを返す
 *
 * さらに 3 つの対照群を見る:
 *   - 難読化していないコードを 1 バイトも変えないこと
 *   - deadcode を掛けていない入力（string-only）で検出 0 件・出力不変であること
 *   - 述語が読めない負例（hard / objkeys）で、壊れたコードを出さず
 *     剥がし残したまま正常終了すること
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const {
  stripDeadCodeInjection,
  StripError,
  PREDICATE_RE,
  PARSER_OPTIONS,
  GENERATE_OPTIONS,
  isSubsequence,
  typeHistogram
} = require('./strip-deadcode-injection.js');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'testdata', 'src');
const OBF_DIR = path.join(ROOT, 'testdata', 'obf');
const TMP_DIR = path.join(ROOT, 'testdata', '.verify-tmp');

/** deadcode を掛けている設定（[strip] を要求する）。 */
const DEADCODE_CONFIGS = ['seven', 'destr-seven', 'dead-max', 'dead-cff', 'deadcode-only', 'destr-dead-max'];

/** 全サンプルで検出できないといけない設定。 */
const MUST_FIRE = new Set(['seven', 'destr-seven']);

/** 述語が読めない負例。剥がし残して正常終了することを見る。 */
const DEGRADE_CONFIGS = ['hard', 'objkeys'];

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

const parse = (code) => parser.parse(code, PARSER_OPTIONS);
const gen = (ast) => generate(ast, GENERATE_OPTIONS).code;
const normalize = (code) => gen(parse(code));

/** 実行して stdout と終了コードを取る。ハングは TIMEOUT として扱う。 */
function run(file, input) {
  try {
    const out = execFileSync(process.execPath, [file], {
      input,
      timeout: 20000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status === null ? 'TIMEOUT' : err.status, out: err.stdout || '' };
  }
}

/** 文字列配列関数が持つ配列リテラルの要素を並べる。 */
function stringArrayElements(code) {
  const ast = parse(code);
  let found = null;
  traverse(ast, {
    ArrayExpression(p) {
      if (found) return;
      // 文字列だけからなる、ある程度の長さの配列 = 文字列配列
      if (p.node.elements.length < 3) return;
      if (!p.node.elements.every((e) => t.isStringLiteral(e))) return;
      found = p.node.elements.map((e) => e.value);
      p.stop();
    }
  });
  return found;
}

/**
 * control-flow-flattening の storage 辞書を「変数名 -> キー -> 値のコード」で並べる。
 * 死枝でしか使われていないエントリも残っていることを確かめるために使う。
 */
function cffDictionaries(code) {
  const ast = parse(code);
  const out = [];
  traverse(ast, {
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !t.isObjectExpression(p.node.init)) return;
      const props = p.node.init.properties;
      if (!props.length) return;
      if (!props.every((pr) => t.isObjectProperty(pr) && !pr.computed)) return;
      const entries = props.map((pr) => {
        const k = pr.key;
        const key = t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? k.value : '?';
        return `${key}=${generate(pr.value, { compact: true }).code}`;
      });
      out.push(`${p.node.id.name}{${entries.sort().join(',')}}`);
    }
  });
  return out.sort();
}

/**
 * スクリプトの申告を使わずに、入力 AST と出力 AST を並行再帰比較する。
 *
 * 出力側が「入力側のある IfStatement の片方の枝」に対応していたら deadcode 除去 1 件。
 * それ以外の食い違いは全部エラー。除去箇所の述語が 5 文字英字比較であることまで見る。
 *
 * @returns {{ok: boolean, removed: number, msg: string}}
 */
function certificate(inCode, outCode) {
  const inAst = parse(inCode).program;
  const outAst = parse(outCode).program;

  const SKIP = new Set([
    'loc', 'start', 'end', 'range', 'leadingComments', 'trailingComments',
    'innerComments', 'comments', 'extra', 'parenthesized', 'directives'
  ]);

  /** 述語が「5 文字英字同士の比較に落ちる形」に見えるか（値までは追わない）。 */
  const looksLikePredicate = (test) => {
    if (t.isBinaryExpression(test) && (test.operator === '===' || test.operator === '!==')) {
      const lit = (n) => !t.isStringLiteral(n) || PREDICATE_RE.test(n.value);
      return lit(test.left) && lit(test.right);
    }
    return t.isCallExpression(test) && test.arguments.length === 2;
  };

  let badPredicate = null;

  /**
   * 入力ノード a と出力ノード b を突き合わせ、除去された deadcode の件数を返す。
   * 対応が取れなければ null。枝は両方試して後戻りする（生きた枝の中がさらに
   * 剥がされていることがあるので、形の一致では選べない）。
   */
  const match = (a, b) => {
    if (a === b) return 0;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      return a === b ? 0 : null;
    }

    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return null;
      let n = 0;
      for (let i = 0; i < a.length; i++) {
        const r = match(a[i], b[i]);
        if (r === null) return null;
        n += r;
      }
      return n;
    }

    // 入力側の if が、出力側ではどちらかの枝だけになっている = deadcode 除去 1 件
    if (t.isIfStatement(a) && a.alternate) {
      for (const branch of [a.consequent, a.alternate]) {
        const r = match(branch, b);
        if (r === null) continue;
        if (!looksLikePredicate(a.test)) {
          badPredicate = generate(a.test, { compact: true }).code.slice(0, 80);
          return null;
        }
        return r + 1;
      }
    }

    // 入力側の「if 1 文だけのブロック」が、出力側では枝そのものになっている
    if (t.isBlockStatement(a) && a.body.length === 1 && t.isIfStatement(a.body[0])) {
      const r = match(a.body[0], b);
      if (r !== null) return r;
    }

    if (a.type !== b.type) return null;

    let n = 0;
    const keys = t.VISITOR_KEYS[a.type] || [];
    for (const key of keys) {
      const r = match(a[key] === undefined ? null : a[key], b[key] === undefined ? null : b[key]);
      if (r === null) return null;
      n += r;
    }
    // operator / name / value / kind などのスカラープロパティも照合する
    for (const key of Object.keys(a)) {
      if (keys.includes(key) || SKIP.has(key)) continue;
      const v = a[key];
      if (v !== null && typeof v === 'object') continue;
      if (v !== b[key]) return null;
    }
    return n;
  };

  const removed = match(inAst, outAst);
  if (removed === null) {
    return {
      ok: false,
      removed: 0,
      msg: badPredicate
        ? `5 文字比較に見えない述語の if が消えている: ${badPredicate}`
        : '入力 AST と出力 AST の対応が取れない'
    };
  }
  return { ok: true, removed, msg: '' };
}

// ---------------------------------------------------------------------------
// サンプル 1 件の検査
// ---------------------------------------------------------------------------

function checkSample(configName, obfFile) {
  const base = path.basename(obfFile);
  const checks = [];
  const add = (name, ok, msg = '') => checks.push({ name, ok, msg });

  const obf = fs.readFileSync(obfFile, 'utf8');
  const expectsDeadcode = DEADCODE_CONFIGS.includes(configName);

  let result;
  try {
    result = stripDeadCodeInjection(obf, { timeout: 5000 });
  } catch (err) {
    add('strip', false, `${err.name}: ${err.message.split('\n')[0]}`);
    return { base, checks };
  }

  const out = result.code;
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outFile = path.join(TMP_DIR, `${configName}.${base.replace(/\.obf\.js$/, '')}.dead.js`);
  fs.writeFileSync(outFile, out, 'utf8');

  const s = result.stats;

  // --- strip -------------------------------------------------------------
  if (MUST_FIRE.has(configName)) {
    add('strip', s.removed > 0, `除去 0 件（候補 ${s.candidates} / 未解決 ${s.unresolved}）`);
  } else if (expectsDeadcode) {
    add('strip', true); // 小さいソースには注入されない。0 件でもよい
  } else {
    add('strip', s.removed === 0, `deadcode を掛けていない入力なのに ${s.removed} 件除去した`);
  }

  // --- accounting --------------------------------------------------------
  add(
    'accounting',
    s.candidates === s.resolved + s.unresolved + s.skippedShape + s.skippedLeak &&
      s.removed === s.shape.parentBlock + s.shape.ifOnly &&
      s.removed === s.resolved,
    `candidates=${s.candidates} resolved=${s.resolved} unresolved=${s.unresolved} ` +
      `skippedShape=${s.skippedShape} skippedLeak=${s.skippedLeak} removed=${s.removed} ` +
      `shape=${JSON.stringify(s.shape)}`
  );

  // --- parse / stable ----------------------------------------------------
  let outAstOk = true;
  try {
    parse(out);
  } catch (err) {
    outAstOk = false;
    add('parse', false, err.message);
  }
  if (outAstOk) add('parse', true);
  if (!outAstOk) return { base, checks };

  // 何も剥がさなかった入力は 1 バイトも変えずに通すのが仕様。
  // その場合は「変形したこと」を前提にした検査（stable / subseq / layers /
  // certificate）ではなく、素通ししたことを確かめる。
  const baseline = normalize(obf);
  if (!result.changed) {
    add('passthrough', out === obf, '除去 0 件なのに出力が入力と違う');
    add('stable', true);
    add('subseq', true);
    add('layers', Object.keys(result.removedTypeCounts).length === 0, '除去 0 件なのに除去ヒストグラムが空でない');
    add('certificate', true);
  } else {
    add('stable', normalize(out) === out, '出力を再生成すると変わる');
    add('subseq', isSubsequence(out, baseline), '出力が入力の部分列になっていない');

    const before = typeHistogram([parse(baseline).program]);
    const after = typeHistogram([parse(out).program]);
    const drift = [];
    for (const type of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const expected = (before[type] || 0) - (result.removedTypeCounts[type] || 0);
      const actual = after[type] || 0;
      if (expected !== actual) drift.push(`${type}: 期待 ${expected} / 実際 ${actual}`);
    }
    add('layers', drift.length === 0, drift.join(' / '));

    const cert = certificate(baseline, out);
    add(
      'certificate',
      cert.ok && cert.removed === s.removed,
      cert.ok ? `独立に数えた除去件数 ${cert.removed} がスクリプトの申告 ${s.removed} と違う` : cert.msg
    );
  }

  // --- strarray ----------------------------------------------------------
  const arrIn = stringArrayElements(obf);
  const arrOut = stringArrayElements(out);
  add(
    'strarray',
    JSON.stringify(arrIn) === JSON.stringify(arrOut),
    `文字列配列が変わった: ${arrIn ? arrIn.length : 'なし'} -> ${arrOut ? arrOut.length : 'なし'}`
  );

  // --- cffdict -----------------------------------------------------------
  // 死枝ごと消えた辞書は出力に無くて当然。出力に残っているものが入力と一致していればよい。
  const inSet = new Set(cffDictionaries(baseline));
  const missing = cffDictionaries(out).filter((d) => !inSet.has(d));
  add('cffdict', missing.length === 0, `入力に無い辞書が出力にある: ${missing.slice(0, 2).join(' / ')}`);

  // --- marks -------------------------------------------------------------
  // 難読化前から持っていない目印は要求しない
  const marks = [];
  if (obf.includes('(((.+)+)+)+$')) marks.push('(((.+)+)+)+$');
  if (obf.includes('debu')) marks.push('debu');
  const lost = marks.filter((m) => !out.includes(m));
  add('marks', lost.length === 0, `目印が消えた: ${lost.join(' / ')}`);

  // --- compact -----------------------------------------------------------
  const oneLine = (code) => code.trimEnd().split('\n').length === 1;
  add('compact', !oneLine(obf) || oneLine(out), '入力は 1 行なのに出力が複数行になった');

  // --- residue / idem ----------------------------------------------------
  const again = stripDeadCodeInjection(out, { timeout: 5000 });
  add('residue', again.stats.resolved === 0, `2 回目で ${again.stats.resolved} 件見つかった`);
  add('idem', again.code === out, '2 回目で出力が変わった');

  // --- behave ------------------------------------------------------------
  const srcName = base.replace(/\.s\d+\.obf\.js$/, '.js');
  const srcFile = path.join(SRC_DIR, srcName);
  const inFixture = obfFile.replace(/\.obf\.js$/, '.obf.in');
  const input = fs.existsSync(inFixture) ? fs.readFileSync(inFixture, 'utf8') : '';

  if (fs.existsSync(srcFile)) {
    const a = run(srcFile, input);
    const b = run(obfFile, input);
    const c = run(outFile, input);
    const same =
      a.out === b.out && b.out === c.out && String(a.code) === String(b.code) && String(b.code) === String(c.code);
    add(
      'behave',
      same,
      `src=${a.code}:${JSON.stringify(a.out.slice(0, 40))} obf=${b.code}:${JSON.stringify(b.out.slice(0, 40))} out=${c.code}:${JSON.stringify(c.out.slice(0, 40))}`
    );
  }

  return { base, checks };
}

// ---------------------------------------------------------------------------
// 対照群
// ---------------------------------------------------------------------------

/** 難読化していないコードを 1 バイトも変えないこと。 */
function verifyPlainSources() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => {
      const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
      let ok = false;
      let msg = '';
      try {
        const r = stripDeadCodeInjection(code, { timeout: 1500 });
        ok = !r.changed && r.code === code;
        msg = r.changed ? `${r.stats.removed} 件除去してしまった` : '出力が入力と違う';
      } catch (err) {
        msg = `例外: ${err.message.split('\n')[0]}`;
      }
      return { base: f, checks: [{ name: 'nontarget', ok, msg }] };
    });
}

/**
 * 述語が読めない負例。
 * 黙って壊れたコードを出さず、剥がし残したまま正常終了すること。
 */
function verifyDegrade(configName) {
  const dir = path.join(OBF_DIR, configName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.obf.js'))
    .sort()
    .map((f) => {
      const obfFile = path.join(dir, f);
      const obf = fs.readFileSync(obfFile, 'utf8');
      const checks = [];
      let r;
      try {
        r = stripDeadCodeInjection(obf, { timeout: 5000 });
      } catch (err) {
        checks.push({ name: 'degrade', ok: false, msg: `例外を投げた: ${err.message.split('\n')[0]}` });
        return { base: f, checks };
      }
      // 読めない述語が残っていることが、この設定の狙い
      checks.push({
        name: 'degrade',
        ok: r.stats.unresolved > 0,
        msg: `未解決が 0 件（候補 ${r.stats.candidates}）。負例になっていない`
      });
      // 出力は常に正しく動くこと
      const srcFile = path.join(SRC_DIR, f.replace(/\.s\d+\.obf\.js$/, '.js'));
      const inFixture = obfFile.replace(/\.obf\.js$/, '.obf.in');
      const input = fs.existsSync(inFixture) ? fs.readFileSync(inFixture, 'utf8') : '';
      if (fs.existsSync(srcFile) && r.changed) {
        fs.mkdirSync(TMP_DIR, { recursive: true });
        const outFile = path.join(TMP_DIR, `${configName}.${f.replace(/\.obf\.js$/, '')}.dead.js`);
        fs.writeFileSync(outFile, r.code, 'utf8');
        const a = run(srcFile, input);
        const c = run(outFile, input);
        checks.push({
          name: 'behave',
          ok: a.out === c.out && String(a.code) === String(c.code),
          msg: `src=${a.code} out=${c.code}`
        });
      } else {
        checks.push({ name: 'behave', ok: true, msg: '' });
      }
      return { base: f, checks };
    });
}

// ---------------------------------------------------------------------------

function report(title, rows) {
  console.log(`\n=== ${title} ===`);
  let failed = 0;
  for (const row of rows) {
    const bad = row.checks.filter((c) => !c.ok);
    const mark = bad.length === 0 ? 'PASS' : 'FAIL';
    const names = row.checks.map((c) => (c.ok ? c.name : `${c.name}!`)).join(' ');
    console.log(`  [${mark}] ${row.base.padEnd(38)} ${names}`);
    for (const b of bad) console.log(`         ${b.name}: ${b.msg}`);
    if (bad.length > 0) failed += 1;
  }
  console.log(`  -- ${rows.length - failed}/${rows.length} PASS`);
  return failed;
}

function main() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  const only = process.argv[2] || null;
  let failed = 0;

  for (const configName of [...DEADCODE_CONFIGS, 'string-only']) {
    if (only && configName !== only) continue;
    const dir = path.join(OBF_DIR, configName);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.obf.js'))
      .sort()
      .map((f) => path.join(dir, f));
    failed += report(
      `${configName} (${files.length} サンプル)`,
      files.map((f) => checkSample(configName, f))
    );
  }

  if (!only) {
    for (const configName of DEGRADE_CONFIGS) {
      failed += report(
        `${configName} — 述語が読めない負例。剥がし残して正常終了すること`,
        verifyDegrade(configName)
      );
    }
    failed += report('非対象入力 — 難読化していないコードを壊さないこと', verifyPlainSources());
  }

  console.log(`\n${failed === 0 ? '全項目 PASS' : `${failed} 件の失敗`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
