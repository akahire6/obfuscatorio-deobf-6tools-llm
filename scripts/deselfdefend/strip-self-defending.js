#!/usr/bin/env node
'use strict';

/**
 * strip-self-defending.js
 *
 * javascript-obfuscator (obfuscator.io) が掛けた難読化のうち、
 * **self-defending の層だけ**を決定論的に剥がす。
 * 姉妹スクリプト ../destring/strip-string-obfuscation.js の self-defending 版で、
 * ../../deobfuscate.js が掛ける 6 段のうち 4 段目。
 *
 * 剥がすもの（= selfDefending が生む 3 部品。同一ブロックにこの順で並ぶ）:
 *   1. calls-controller  var F = (function(){ var firstCall=!![];
 *                          return function(ctx,fn){ .. fn.apply(ctx,arguments) .. }; }())
 *   2. 自己検査 callee    var S = F(this, function(){
 *                          return S.toString().search('(((.+)+)+)+$')
 *                                  .toString().constructor(S).search('(((.+)+)+)+$'); })
 *   3. 起動文            S();
 *
 * 触らないもの（= 残り 6 変換はそのまま残る）:
 *   string-obfuscation の文字列配列（self-defending が使っていた '(((.+)+)+)+$' が
 *   配列に残るのは正しい。抜くとローテータの検査和が壊れる）/
 *   control-flow-flattening の辞書オブジェクト（使われなくなる転送関数も残す）/
 *   deadcode-injection のダミー分岐 / debug-protection 一式 /
 *   name-obfuscation の 16 進識別子 / code-compact。
 *
 * ★ 出力は「入力から 3 区間を切り出しただけ」。AST の再生成はしない。
 *   他 6 層が 1 バイトも変わらないことが自明になり、code-compact も自動的に保たれる。
 *
 * ★ debug-protection との弁別。両者とも同じ形の calls-controller を独立に生成するが、
 *     self-defending   : var S = F(this, fn); S();
 *                        → 戻り値を変数に束縛し、fn の本体がその変数を参照する（自己参照）
 *     debug-protection : F(this, fn)()
 *                        → 即時実行、束縛なし、自己参照なし、new RegExp を 2 個作る
 *   自己参照の有無が決定的な弁別子。
 *
 * ★ テキスト検索は使えない。目印 '(((.+)+)+)+$' の出現数はサンプルごとに 1〜3 回で、
 *   deadcode-injection が self-defending 本体のコピーを死んだ分岐にばら撒く。
 *   文字列配列に吸われて本文から消えることもある。
 *
 * ★ 文字列は「読む」が「書き戻さない」。
 *   control-flow-flattening は F(this,fn) を DICT['JuIrv'](F,this,fn) に、S() を
 *   DICT['qbHnB'](S) に書き換える。しかもその辞書キー自体が DICT[dec(0x1cf)] の形で
 *   文字列配列に入ることがあり、リテラルキーしか見ない検出器は 36 サンプル中 29 件しか
 *   当たらない。検出のために ../destring の部品を借りてデコーダを vm 上に組み立て、
 *   キーとメソッド名を照合する。出力の文字列表現は一切変えない。
 *
 * ★ 安全弁: 少しでも確信が持てない状況（候補が複数、辞書キーが読めない、
 *   起動文が見つからない、calls-controller が共有されている、3 部品がばらけている）では
 *   出力せず非ゼロ終了する。黙って壊れたコードを出さない。
 */

const fs = require('fs');
const path = require('path');

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const destring = require('../destring/strip-string-obfuscation.js');

const PARSER_OPTIONS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true
};

/** self-defending が整形検出に使う正規表現文字列。確証として記録するだけで、検出条件にはしない。 */
const SELF_DEFENDING_MARKER = '(((.+)+)+)+$';

/** 自己検査の連鎖で必ず使われるメソッド名。 */
const REQUIRED_METHODS = ['toString', 'search', 'constructor'];

class StripError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripError';
  }
}

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/** 部分木を走査する（Babel の VISITOR_KEYS を使う素朴な再帰）。 */
function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key of t.VISITOR_KEYS[node.type] || []) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => walk(c, fn));
    else if (child && typeof child.type === 'string') walk(child, fn);
  }
}

/** 部分木のノード種別ヒストグラム（検証で「何を消したか」を機械的に照合するため）。 */
function typeHistogram(nodes) {
  const counts = Object.create(null);
  for (const n of nodes) walk(n, (x) => {
    counts[x.type] = (counts[x.type] || 0) + 1;
  });
  return counts;
}

/** obfuscator が真偽値に使う !![] / ![] とただの true / false を同一視する。 */
function isTrueish(node) {
  if (t.isBooleanLiteral(node, { value: true })) return true;
  return (
    t.isUnaryExpression(node, { operator: '!' }) &&
    t.isUnaryExpression(node.argument, { operator: '!' }) &&
    t.isArrayExpression(node.argument.argument) &&
    node.argument.argument.elements.length === 0
  );
}

/**
 * calls-controller（1 回だけ実行ラッパ）の形か。
 *   (function(){ var firstCall = !![];
 *     return function(ctx, fn){
 *       var rfn = firstCall ? function(){ if(fn){ var r = fn.apply(ctx, arguments); fn = null; return r; } }
 *                           : function(){};
 *       firstCall = ![]; return rfn; }; }())
 * deadcode-injection / control-flow-flattening で本体が歪むので、
 * 「引数なし IIFE」「真リテラル」「arguments を実引数に渡す呼び出し」の 3 点だけを見る。
 */
function looksLikeCallsController(node) {
  if (!t.isCallExpression(node) || node.arguments.length !== 0) return false;
  const fn = node.callee;
  if (!t.isFunctionExpression(fn) && !t.isArrowFunctionExpression(fn)) return false;

  let hasFlag = false;
  let forwardsArguments = false;
  walk(fn.body, (n) => {
    if (isTrueish(n)) hasFlag = true;
    if (t.isCallExpression(n) && n.arguments.some((a) => t.isIdentifier(a, { name: 'arguments' }))) {
      forwardsArguments = true;
    }
  });
  return hasFlag && forwardsArguments;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * コードから self-defending の層だけを剥がす。
 * @returns {{code: string, stats: object, changed: boolean, removedNodes: object[]}}
 */
function stripSelfDefending(code, options = {}) {
  const timeoutMs = options.timeout || 5000;

  let ast;
  try {
    ast = parser.parse(code, PARSER_OPTIONS);
  } catch (err) {
    throw new StripError(`入力をパースできない: ${err.message}`);
  }

  // --- 1. 文字列配列デコーダを借りる（読むだけ。書き戻さない） ----------------
  //     ../destring の部品検出器をそのまま使う。組み立てられなければ decode = null。
  let arrayFn = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (arrayFn) return;
      const m = destring.matchStringArrayFunction(p.node);
      if (m) arrayFn = { ...m, path: p };
    }
  });

  let decode = null;
  let decoderName = null;
  const aliasBindings = new Set();

  if (arrayFn) {
    let decoderFn = null;
    traverse(ast, {
      FunctionDeclaration(p) {
        if (decoderFn) return;
        const m = destring.matchDecoderFunction(p.node, arrayFn.name);
        if (m) decoderFn = { ...m, path: p };
      }
    });

    if (decoderFn) {
      let rotator = null;
      traverse(ast, {
        ExpressionStatement(p) {
          if (rotator) return;
          if (destring.matchRotatorStatement(p.node, arrayFn.name)) rotator = p;
        }
      });

      let decoderBinding = null;
      traverse(ast, {
        Program(p) {
          decoderBinding = p.scope.getBinding(decoderFn.name);
          p.stop();
        }
      });

      if (decoderBinding) {
        aliasBindings.add(decoderBinding);
        // ラッパー別名を不動点で集める（chained calls で多段になる）
        for (let pass = 0; pass < 16; pass++) {
          let added = false;
          traverse(ast, {
            VariableDeclarator(p) {
              if (!t.isIdentifier(p.node.id) || !t.isIdentifier(p.node.init)) return;
              const target = p.scope.getBinding(p.node.init.name);
              if (!target || !aliasBindings.has(target)) return;
              const self = p.scope.getBinding(p.node.id.name);
              if (!self || aliasBindings.has(self)) return;
              aliasBindings.add(self);
              added = true;
            }
          });
          if (!added) break;
        }

        try {
          decode = destring.buildDecoder(
            arrayFn.path.node,
            decoderFn.path.node,
            rotator ? rotator.node : null,
            decoderFn.name,
            timeoutMs
          );
          decoderName = decoderFn.name;
        } catch (_) {
          // base64/rc4 + calls transform などデコーダを組み立てられない設定。
          // 文字列が読めないだけなので、読めるものだけを扱って続行する（後段の安全弁が働く）。
          decode = null;
        }
      }
    }
  }

  /** 文字列リテラル、またはデコーダ呼び出しを実際の文字列に解決する。 */
  function resolveString(node, scopePath) {
    if (t.isStringLiteral(node)) return { ok: true, value: node.value };
    if (!decode) return { ok: false };
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return { ok: false };
    const binding = scopePath.scope.getBinding(node.callee.name);
    if (!binding || !aliasBindings.has(binding)) return { ok: false };
    const args = node.arguments.map((a) => destring.literalArgValue(a));
    if (!args.every((a) => a.ok)) return { ok: false };
    try {
      const v = decode.apply(null, args.map((a) => a.value));
      if (typeof v === 'string') return { ok: true, value: v };
    } catch (_) {
      /* 解決できないだけ。安全弁は後段 */
    }
    return { ok: false };
  }

  /** メンバ式のプロパティ名を解決する（o.k / o['k'] / o[dec(0x1)] のいずれも）。 */
  function resolveMemberKey(member, scopePath) {
    if (!member.computed && t.isIdentifier(member.property)) return { ok: true, value: member.property.name };
    return resolveString(member.property, scopePath);
  }

  /**
   * control-flow-flattening の辞書経由呼び出しを読み替える。
   *   DICT['k'](f, a, b)  かつ  DICT.k = function(p0,p1,p2){ return p0(p1,p2); }
   *   → f(a, b) と同じ
   * 直接呼び出し f(a, b) はそのまま返す。読み替えられなければ null。
   */
  function unwrapCall(callPath) {
    const node = callPath.node;
    if (!t.isCallExpression(node)) return null;

    if (t.isIdentifier(node.callee)) {
      return { fnName: node.callee.name, args: node.arguments, via: 'direct' };
    }
    if (!t.isMemberExpression(node.callee) || !t.isIdentifier(node.callee.object)) return null;

    const objName = node.callee.object.name;
    const binding = callPath.scope.getBinding(objName);
    if (!binding || !t.isVariableDeclarator(binding.path.node)) return null;
    const dict = binding.path.node.init;
    if (!t.isObjectExpression(dict)) return null;

    const key = resolveMemberKey(node.callee, callPath);
    if (!key.ok) return null;

    const prop = dict.properties.find(
      (pr) =>
        t.isObjectProperty(pr) &&
        ((t.isIdentifier(pr.key) && !pr.computed && pr.key.name === key.value) ||
          (t.isStringLiteral(pr.key) && pr.key.value === key.value))
    );
    if (!prop || !t.isFunctionExpression(prop.value)) return null;

    // 転送関数 function(p0, p1..pn){ return p0(p1..pn); } であること
    const fn = prop.value;
    const body = fn.body.body;
    if (body.length !== 1 || !t.isReturnStatement(body[0]) || !t.isCallExpression(body[0].argument)) return null;
    const inner = body[0].argument;
    if (!t.isIdentifier(inner.callee) || !fn.params[0] || inner.callee.name !== fn.params[0].name) return null;
    if (inner.arguments.length !== fn.params.length - 1) return null;
    const forwards = inner.arguments.every(
      (a, i) => t.isIdentifier(a) && fn.params[i + 1] && t.isIdentifier(fn.params[i + 1], { name: a.name })
    );
    if (!forwards) return null;
    if (node.arguments.length !== fn.params.length) return null;
    if (!t.isIdentifier(node.arguments[0])) return null;

    return {
      fnName: node.arguments[0].name,
      args: node.arguments.slice(1),
      via: `cff:${objName}.${key.value}`
    };
  }

  /** ある参照パスが対象の関数式の内側にいるか。 */
  function isInside(refPath, node) {
    let cur = refPath;
    while (cur) {
      if (cur.node === node) return true;
      cur = cur.parentPath;
    }
    return false;
  }

  // --- 2. 候補を集める ----------------------------------------------------
  //     ゆるい条件（= self-defending を見落とさないための網）:
  //       var S = <なんらかの呼び出し>  で、実引数に this と関数式が並び、
  //       その関数式の中から S 自身が参照されている（自己参照）。
  //     debug-protection は戻り値を束縛しないので、この網には掛からない。
  const loose = [];
  traverse(ast, {
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !t.isCallExpression(p.node.init)) return;

      const rawArgs = p.node.init.arguments;
      const callee = rawArgs.find((a) => t.isFunctionExpression(a) || t.isArrowFunctionExpression(a));
      if (!callee || !rawArgs.some((a) => t.isThisExpression(a))) return;

      const binding = p.scope.getBinding(p.node.id.name);
      if (!binding) return;
      const selfRefs = binding.referencePaths.filter((rp) => isInside(rp, callee));
      if (selfRefs.length < 2) return;

      loose.push({ declPath: p, name: p.node.id.name, binding, callee });
    }
  });

  if (loose.length === 0) {
    // self-defending が掛かっていない入力。何もせず通す（冪等）。
    return { code, changed: false, removedNodes: [], stats: { reason: 'no-self-defending' } };
  }
  if (loose.length > 1) {
    throw new StripError(
      `self-defending の候補が ${loose.length} 件ある（${loose.map((c) => c.name).join(', ')}）。` +
        'どれを消すべきか決められないので中止する。'
    );
  }

  const cand = loose[0];
  const refuse = (msg) => {
    throw new StripError(`self-defending らしき ${cand.name} を見つけたが確定できない: ${msg}`);
  };

  // --- 3. 厳密に確定させる ------------------------------------------------

  // 3-a. 生成呼び出しを読み替えて  F(this, fn)  の形であることを確かめる
  const made = unwrapCall(cand.declPath.get('init'));
  if (!made) {
    refuse(
      'F(this, fn) の呼び出しを読み解けない' +
        (decode ? '' : '（文字列配列デコーダを組み立てられなかったので辞書キーが読めない）')
    );
  }
  if (made.args.length !== 2 || !t.isThisExpression(made.args[0]) || made.args[1] !== cand.callee) {
    refuse('実引数が (this, function(){..}) の形になっていない');
  }

  // 3-b. 自己検査の連鎖に toString / search / constructor が揃っていること
  const methodNames = new Set();
  let marker = false;
  cand.declPath.get('init').traverse({
    MemberExpression(p) {
      const k = resolveMemberKey(p.node, p);
      if (k.ok) methodNames.add(k.value);
    },
    CallExpression(p) {
      for (const a of p.node.arguments) {
        const s = resolveString(a, p);
        if (s.ok && s.value === SELF_DEFENDING_MARKER) marker = true;
      }
    }
  });
  for (const a of cand.callee.body.directives || []) {
    if (a.value && a.value.value === SELF_DEFENDING_MARKER) marker = true;
  }
  const missing = REQUIRED_METHODS.filter((m) => !methodNames.has(m));
  if (missing.length > 0) {
    refuse(
      `自己検査の連鎖に ${missing.join(' / ')} が見当たらない` +
        (decode ? '' : '（文字列配列デコーダを組み立てられなかったのでメソッド名が読めない）')
    );
  }

  // 3-c. 起動文 S() がちょうど 1 つあること
  const invocations = cand.binding.referencePaths
    .map((rp) => {
      const call = rp.parentPath;
      if (!call || !call.isCallExpression()) return null;
      const u = unwrapCall(call);
      if (!u || u.fnName !== cand.name || u.args.length !== 0) return null;
      if (!call.parentPath.isExpressionStatement()) return null;
      return { stmt: call.parentPath, via: u.via };
    })
    .filter(Boolean);

  if (invocations.length !== 1) {
    refuse(`起動文 ${cand.name}() が ${invocations.length} 個ある（ちょうど 1 個であるべき）`);
  }
  const invocation = invocations[0];

  // 3-d. calls-controller が self-defending 専用であること
  const fBinding = cand.declPath.scope.getBinding(made.fnName);
  if (!fBinding || !fBinding.path.isVariableDeclarator()) {
    refuse(`calls-controller ${made.fnName} の宣言が見つからない`);
  }
  if (!looksLikeCallsController(fBinding.path.node.init)) {
    refuse(`${made.fnName} が calls-controller の形をしていない`);
  }
  if (fBinding.references !== 1) {
    refuse(
      `calls-controller ${made.fnName} が ${fBinding.references} 箇所から参照されている` +
        '（debug-protection と共有されている可能性があるので消さない）'
    );
  }

  // 3-e. 3 部品が同一ブロックの兄弟で、宣言子が 1 個ずつであること
  const fStmt = fBinding.path.parentPath;
  const sStmt = cand.declPath.parentPath;
  const iStmt = invocation.stmt;

  if (!fStmt.isVariableDeclaration() || fStmt.node.declarations.length !== 1) {
    refuse(`calls-controller ${made.fnName} の宣言に他の変数が同居している`);
  }
  if (!sStmt.isVariableDeclaration() || sStmt.node.declarations.length !== 1) {
    refuse(`${cand.name} の宣言に他の変数が同居している`);
  }
  if (fStmt.parentPath !== sStmt.parentPath || sStmt.parentPath !== iStmt.parentPath) {
    refuse('3 部品が同じブロックに並んでいない');
  }
  if (!(fStmt.node.start < sStmt.node.start && sStmt.node.start < iStmt.node.start)) {
    refuse('3 部品の並び順が想定と違う');
  }

  // --- 4. テキストから 3 区間を切り出す -----------------------------------
  const removedNodes = [fStmt.node, sStmt.node, iStmt.node];
  const ranges = removedNodes
    .map((n) => [n.start, n.end])
    .sort((a, b) => b[0] - a[0]); // 後ろから消す

  let out = code;
  for (const [s, e] of ranges) out = out.slice(0, s) + out.slice(e);

  try {
    parser.parse(out, PARSER_OPTIONS);
  } catch (err) {
    throw new StripError(`除去後のコードがパースできなくなった: ${err.message}`);
  }

  const stats = {
    controller: made.fnName,
    callee: cand.name,
    calleeVia: made.via,
    invocationVia: invocation.via,
    decoder: decoderName,
    marker,
    removedBytes: code.length - out.length,
    removedRanges: ranges.slice().sort((a, b) => a[0] - b[0])
  };

  return { code: out, changed: true, removedNodes, stats };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
strip-self-defending — javascript-obfuscator の出力から self-defending 層だけを剥がす

  node strip-self-defending.js <input.js> [-o <output.js>]
  node strip-self-defending.js --batch <indir> -o <outdir> [options]

  -o, --out <path>       出力先（省略時は stdout）
      --batch <dir>      ディレクトリを一括処理（-o <outdir> が必要）
      --ext <suffix>     --batch で拾う拡張子（既定 .js）
      --suffix <suffix>  --batch の出力の拡張子（既定 .js）
      --continue-on-error  失敗しても次のファイルへ進む
      --timeout <ms>     デコーダ評価のタイムアウト（既定 5000）
      --stats            何を消したかを stderr に出す
  -h, --help             このヘルプ
`;

function parseArgs(argv) {
  const opts = {
    input: null,
    out: null,
    batch: null,
    ext: '.js',
    suffix: '.js',
    continueOnError: false,
    timeout: 5000,
    stats: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === '-o' || a === '--out') {
      opts.out = argv[++i];
    } else if (a === '--batch') {
      opts.batch = argv[++i];
    } else if (a === '--ext') {
      opts.ext = argv[++i];
    } else if (a === '--suffix') {
      opts.suffix = argv[++i];
    } else if (a === '--continue-on-error') {
      opts.continueOnError = true;
    } else if (a === '--timeout') {
      opts.timeout = parseInt(argv[++i], 10);
    } else if (a === '--stats') {
      opts.stats = true;
    } else if (a.startsWith('-')) {
      throw new Error(`不明なオプション: ${a}`);
    } else if (!opts.input) {
      opts.input = a;
    } else {
      throw new Error(`引数が多すぎる: ${a}`);
    }
  }
  return opts;
}

function processOne(inFile, outFile, opts) {
  const code = fs.readFileSync(inFile, 'utf8');
  const result = stripSelfDefending(code, { timeout: opts.timeout });

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, result.code, 'utf8');
  } else {
    process.stdout.write(result.code + '\n');
  }

  if (opts.stats) {
    process.stderr.write(`${path.basename(inFile)}: ${JSON.stringify(result.stats)}\n`);
  }
  return result;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (opts.batch) {
    if (!opts.out) {
      process.stderr.write('--batch には -o <outdir> が必要\n');
      process.exit(2);
    }
    const files = fs
      .readdirSync(opts.batch)
      .filter((f) => f.endsWith(opts.ext))
      .sort();

    let ok = 0;
    let unchanged = 0;
    const failures = [];

    for (const f of files) {
      const inFile = path.join(opts.batch, f);
      const base = f.slice(0, f.length - opts.ext.length);
      const outFile = path.join(opts.out, base + opts.suffix);
      try {
        const r = processOne(inFile, outFile, opts);
        ok += 1;
        if (!r.changed) unchanged += 1;
      } catch (err) {
        failures.push({ file: f, message: err.message });
        if (!opts.continueOnError) {
          process.stderr.write(`失敗: ${f}\n  ${err.message}\n`);
          process.exit(1);
        }
      }
    }

    process.stderr.write(
      `\n処理 ${files.length} 件: 成功 ${ok}（うち対象なし ${unchanged}） / 失敗 ${failures.length}\n`
    );
    for (const f of failures) {
      process.stderr.write(`  - ${f.file}: ${f.message.split('\n')[0]}\n`);
    }
    process.exit(failures.length > 0 ? 1 : 0);
  }

  if (!opts.input) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  try {
    processOne(opts.input, opts.out, opts);
  } catch (err) {
    if (err instanceof StripError) {
      process.stderr.write(`失敗: ${opts.input}\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

module.exports = { stripSelfDefending, StripError, typeHistogram };

if (require.main === module) {
  main();
}
