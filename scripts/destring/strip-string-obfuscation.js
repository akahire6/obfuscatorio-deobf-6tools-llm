#!/usr/bin/env node
'use strict';

/**
 * strip-string-obfuscation.js
 *
 * javascript-obfuscator (obfuscator.io) が掛けた難読化のうち、
 * **string-obfuscation の層だけ**を決定論的に剥がす。
 *
 * 剥がすもの（= stringArray 変換が生む 4 部品）:
 *   1. 文字列配列関数   function F(){var A=['..','..'];F=function(){return A;};return F();}
 *   2. デコーダ関数     function D(a,b){var A=F();D=function(x,y){x=x-OFF;return A[x];};return D(a,b);}
 *   3. ローテータ IIFE  (function(f,n){var A=f();while(!![]){try{..}catch(e){A.push(A.shift());}}}(F,0x1950f))
 *   4. ラッパー別名     var W1=D;  /  const W2=W1;   （chained calls なので多段になる）
 *   そして W2(0x156) のような呼び出しを、実際の文字列リテラルに畳み込む。
 *
 * 触らないもの（= 残り 6 変換はそのまま残る）:
 *   deadcode-injection のダミー分岐 / control-flow-flattening の辞書オブジェクト /
 *   debug-protection / self-defending / name-obfuscation の 16 進識別子 / code-compact。
 *
 * ★ 出力は 1 行 compact のまま。整形して出してはいけない。
 *   (a) code-compact まで解除したことになる。
 *   (b) self-defending は fn.toString().search('(((.+)+)+)+$') で整形を検出する。
 *       改行が入ると catastrophic backtracking で事実上ハングする。
 *
 * ★ 安全弁: 少しでも確信が持てない状況（リテラル以外の引数、デコード失敗、
 *   剥がし残りの参照）では出力せず非ゼロ終了する。黙って壊れたコードを出さない。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const PARSER_OPTIONS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  errorRecovery: false
};

/** 安全弁が発火したときに投げる。CLI 側で理由つきの失敗として扱う。 */
class StripError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripError';
  }
}

// ---------------------------------------------------------------------------
// 部品の検出
// ---------------------------------------------------------------------------

/**
 * 文字列配列関数か判定する。
 *   function F(){ var A = ['..', '..']; F = function(){ return A; }; return F(); }
 * var / let / const の違い、文の並び順の揺れは許容し、以下の 2 点だけを要求する:
 *   - 全要素が文字列リテラルの配列リテラルを、宣言で 1 つ持つ
 *   - 自分自身への再代入（右辺が関数式）がある
 */
function matchStringArrayFunction(node) {
  if (!t.isFunctionDeclaration(node) || node.params.length !== 0 || !node.id) return null;

  const name = node.id.name;
  const body = node.body.body;

  let arrayNode = null;
  let selfAssigned = false;

  for (const stmt of body) {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (
          t.isArrayExpression(decl.init) &&
          decl.init.elements.length > 0 &&
          decl.init.elements.every((el) => t.isStringLiteral(el))
        ) {
          arrayNode = decl.init;
        }
      }
    } else if (
      t.isExpressionStatement(stmt) &&
      t.isAssignmentExpression(stmt.expression, { operator: '=' }) &&
      t.isIdentifier(stmt.expression.left, { name }) &&
      t.isFunctionExpression(stmt.expression.right)
    ) {
      selfAssigned = true;
    }
  }

  if (!arrayNode || !selfAssigned) return null;
  return { name, strings: arrayNode.elements.map((el) => el.value) };
}

/**
 * デコーダ関数か判定する。javascript-obfuscator のバージョンで 2 つの形がある:
 *
 *   (旧) function D(a,b){ var A=F(); D=function(x,y){ x=x-OFF; return A[x]; }; return D(a,b); }
 *   (新) function D(a,b){ a=a-OFF; var A=F(); var v=A[a]; return v; }
 *
 * どちらも「引数 2 個の関数宣言」で「文字列配列関数を呼んでいる」。この 2 点だけを要求し、
 * 自己再代入の有無・インデックスオフセット・rc4/base64 デコードの有無には依存しない
 * （実際に vm で評価するので、中身を読み解く必要がない）。
 * 文字列配列関数は難読化器が生成した名前なので、これを呼ぶ 2 引数関数は他に存在しない。
 */
function matchDecoderFunction(node, arrayFnName) {
  if (!t.isFunctionDeclaration(node) || node.params.length !== 2 || !node.id) return null;

  const name = node.id.name;
  let callsArrayFn = false;

  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: arrayFnName })) {
      callsArrayFn = true;
    }
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(node.body);

  if (!callsArrayFn) return null;
  return { name };
}

/**
 * ローテータ IIFE か判定する。
 *   (function(f, n){ var A = f(); while(!![]){ try{ ...  } catch(e){ A.push(A.shift()); } } }(F, 0x1950f))
 * 実引数が [配列関数名, 数値リテラル] であることと、本体に while と push/shift があることを見る。
 */
function matchRotatorStatement(stmt, arrayFnName) {
  if (!t.isExpressionStatement(stmt)) return false;

  let call = stmt.expression;
  if (t.isUnaryExpression(call) || t.isSequenceExpression(call)) return false;
  if (!t.isCallExpression(call)) return false;
  if (!t.isFunctionExpression(call.callee) || call.callee.params.length !== 2) return false;
  if (call.arguments.length !== 2) return false;
  if (!t.isIdentifier(call.arguments[0], { name: arrayFnName })) return false;
  if (!t.isNumericLiteral(call.arguments[1])) return false;

  let hasWhile = false;
  let hasShift = false;
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (t.isWhileStatement(n)) hasWhile = true;
    if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property, { name: 'shift' })) hasShift = true;
    if (t.isMemberExpression(n) && n.computed && t.isStringLiteral(n.property, { value: 'shift' })) hasShift = true;
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(call.callee.body);

  return hasWhile && hasShift;
}

// ---------------------------------------------------------------------------
// デコーダの実評価
// ---------------------------------------------------------------------------

/**
 * 配列関数・デコーダ・ローテータの 3 つだけを取り出して vm で実行し、
 * 呼び出し可能なデコード関数を得る。
 *
 * ローテータが走ることで配列が最終的な回転状態に落ち着く。この 3 部品は
 * parseInt 以外の外部依存を持たない自己完結コードなので、
 * debug-protection / self-defending のコードは一切実行されない。
 */
function buildDecoder(arrayFnNode, decoderFnNode, rotatorNode, decoderName, timeoutMs) {
  const parts = [arrayFnNode, decoderFnNode];
  if (rotatorNode) parts.push(rotatorNode);

  const source =
    parts.map((n) => generate(n, { compact: true }).code).join('\n') +
    `\nglobalThis.__destring_decode = function () { return ${decoderName}.apply(null, arguments); };\n`;

  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox);

  try {
    vm.runInContext(source, context, { timeout: timeoutMs, displayErrors: true });
  } catch (err) {
    throw new StripError(`デコーダの評価に失敗した: ${err.message}`);
  }

  const decode = sandbox.__destring_decode;
  if (typeof decode !== 'function') {
    throw new StripError('デコーダの評価に失敗した: デコード関数を取り出せなかった');
  }
  return decode;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/** デコーダ呼び出しの実引数として許されるリテラルか。数値・文字列・単項マイナス付き数値。 */
function literalArgValue(node) {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node)) return { ok: true, value: node.value };
  if (t.isUnaryExpression(node, { operator: '-' }) && t.isNumericLiteral(node.argument)) {
    return { ok: true, value: -node.argument.value };
  }
  return { ok: false };
}

/** 部分木のノード種別ヒストグラムを取る（検証で「何を消したか」を機械的に照合するため）。 */
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

/** 祖先をたどって、いずれかの除去予定ノードの内側にいるかを見る。 */
function isInsideAny(nodePath, nodes) {
  let cur = nodePath;
  while (cur) {
    if (nodes.has(cur.node)) return true;
    cur = cur.parentPath;
  }
  return false;
}

/**
 * コードから string-obfuscation の層だけを剥がす。
 * @returns {{code: string, stats: object, changed: boolean}}
 */
function stripStringObfuscation(code, options = {}) {
  const timeoutMs = options.timeout || 5000;

  let ast;
  try {
    ast = parser.parse(code, PARSER_OPTIONS);
  } catch (err) {
    throw new StripError(`入力をパースできない: ${err.message}`);
  }

  // --- 1. 文字列配列関数を探す -------------------------------------------
  let arrayFn = null; // { name, strings, path }
  traverse(ast, {
    FunctionDeclaration(p) {
      if (arrayFn) return;
      const m = matchStringArrayFunction(p.node);
      if (m) arrayFn = { ...m, path: p };
    }
  });

  if (!arrayFn) {
    // string-obfuscation が掛かっていない入力。何もせず通す。
    return { code, changed: false, stats: { reason: 'no-string-array' } };
  }

  // --- 2. デコーダ関数を探す ---------------------------------------------
  let decoderFn = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (decoderFn) return;
      const m = matchDecoderFunction(p.node, arrayFn.name);
      if (m) decoderFn = { ...m, path: p };
    }
  });

  if (!decoderFn) {
    throw new StripError(
      `文字列配列関数 ${arrayFn.name} は見つかったがデコーダ関数が見つからない` +
        '（stringArrayCallsTransform など未対応の設定の可能性がある）'
    );
  }

  // --- 3. ローテータ IIFE を探す（Rotate 無効時は存在しないので必須にしない） ---
  let rotatorPath = null;
  traverse(ast, {
    ExpressionStatement(p) {
      if (rotatorPath) return;
      if (matchRotatorStatement(p.node, arrayFn.name)) rotatorPath = p;
    }
  });

  // --- 4. ラッパー別名を不動点で集める ------------------------------------
  let programScope = null;
  traverse(ast, {
    Program(p) {
      programScope = p.scope;
      p.stop();
    }
  });

  const decoderBinding = programScope.getBinding(decoderFn.name);
  if (!decoderBinding) {
    throw new StripError(`デコーダ ${decoderFn.name} の束縛を解決できない`);
  }

  const aliasBindings = new Set([decoderBinding]);
  const aliasDeclarators = []; // 除去対象の VariableDeclarator path

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
        aliasDeclarators.push(p);
        added = true;
      }
    });
    if (!added) break;
  }

  // --- 5. デコーダを評価する ---------------------------------------------
  const decode = buildDecoder(
    arrayFn.path.node,
    decoderFn.path.node,
    rotatorPath ? rotatorPath.node : null,
    decoderFn.name,
    timeoutMs
  );

  // --- 6. 除去予定ノードを確定（この内側の参照は「残骸」として数えない）----
  const removalNodes = new Set([arrayFn.path.node, decoderFn.path.node]);
  if (rotatorPath) removalNodes.add(rotatorPath.node);
  for (const d of aliasDeclarators) removalNodes.add(d.node);

  // --- 7. 呼び出しをリテラルに畳み込む ------------------------------------
  let folded = 0;
  const badCalls = [];
  const foldedValues = new Set(); // コードに戻した文字列
  const internalValues = new Set(); // ローテータの検査和など、部品の内側だけで使われる文字列

  traverse(ast, {
    CallExpression(p) {
      if (!t.isIdentifier(p.node.callee)) return;
      const binding = p.scope.getBinding(p.node.callee.name);
      if (!binding || !aliasBindings.has(binding)) return;

      // 部品の内側（ローテータの検査和計算など）は畳み込まない。
      // ただし「配列のどの要素が使われたか」は記録しておく（検証で突き合わせるため）。
      if (isInsideAny(p, removalNodes)) {
        const args = p.node.arguments.map(literalArgValue);
        if (args.every((a) => a.ok)) {
          try {
            const v = decode.apply(null, args.map((a) => a.value));
            if (typeof v === 'string') internalValues.add(v);
          } catch (_) {
            /* 記録できなくても本処理には影響しない */
          }
        }
        return;
      }

      const args = [];
      for (const a of p.node.arguments) {
        const lit = literalArgValue(a);
        if (!lit.ok) {
          const loc = p.node.loc ? `${p.node.loc.start.line}:${p.node.loc.start.column}` : '?';
          badCalls.push(`${p.node.callee.name}(...) at ${loc}: 引数がリテラルでない`);
          return;
        }
        args.push(lit.value);
      }

      let value;
      try {
        value = decode.apply(null, args);
      } catch (err) {
        badCalls.push(`${p.node.callee.name}(${args.join(',')}): デコード中に例外 ${err.message}`);
        return;
      }
      if (typeof value !== 'string') {
        badCalls.push(`${p.node.callee.name}(${args.join(',')}): 文字列以外を返した (${typeof value})`);
        return;
      }

      p.replaceWith(t.stringLiteral(value));
      foldedValues.add(value);
      folded += 1;
    }
  });

  if (badCalls.length > 0) {
    throw new StripError(
      `畳み込めないデコーダ呼び出しが ${badCalls.length} 件ある:\n  ` + badCalls.slice(0, 5).join('\n  ')
    );
  }

  // --- 8. 剥がし残りの参照がないか検査 -------------------------------------
  programScope.crawl();

  const leftovers = [];
  const checkName = (name) => {
    const b = programScope.getBinding(name);
    if (!b) return;
    for (const ref of b.referencePaths) {
      if (!isInsideAny(ref, removalNodes)) {
        const loc = ref.node.loc ? `${ref.node.loc.start.line}:${ref.node.loc.start.column}` : '?';
        leftovers.push(`${name} at ${loc}`);
      }
    }
  };
  checkName(arrayFn.name);
  checkName(decoderFn.name);
  for (const d of aliasDeclarators) {
    if (t.isIdentifier(d.node.id)) checkName(d.node.id.name);
  }

  if (leftovers.length > 0) {
    throw new StripError(
      `畳み込み後も string-obfuscation 部品への参照が ${leftovers.length} 件残っている:\n  ` +
        leftovers.slice(0, 5).join('\n  ')
    );
  }

  // --- 9. 残骸を削除 -------------------------------------------------------
  // 消す前に「何を消すか」のヒストグラムを取っておく。verify.js はこれを使って
  // 「消したもの以外は 1 ノードも変わっていない」を機械的に照合する。
  const removedTypeCounts = typeHistogram([...removalNodes]);

  const removeDeclarator = (p) => {
    const decl = p.parentPath;
    p.remove();
    if (t.isVariableDeclaration(decl.node) && decl.node.declarations.length === 0) {
      decl.remove();
    }
  };

  for (const d of aliasDeclarators) {
    if (d.removed) continue;
    removeDeclarator(d);
  }
  if (rotatorPath && !rotatorPath.removed) rotatorPath.remove();
  if (!decoderFn.path.removed) decoderFn.path.remove();
  if (!arrayFn.path.removed) arrayFn.path.remove();

  // --- 10. 1 行 compact で出力 ---------------------------------------------
  const out = generate(ast, {
    compact: true,
    comments: false,
    jsescOption: { quotes: 'single', wrap: true }
  }).code;

  // 出力が壊れていないことだけは必ず確かめる
  try {
    parser.parse(out, PARSER_OPTIONS);
  } catch (err) {
    throw new StripError(`生成したコードがパースできない: ${err.message}`);
  }

  return {
    code: out,
    changed: true,
    strings: arrayFn.strings,
    foldedValues: [...foldedValues],
    internalValues: [...internalValues],
    removedTypeCounts,
    stats: {
      stringArrayFunction: arrayFn.name,
      decoderFunction: decoderFn.name,
      rotator: Boolean(rotatorPath),
      arrayLength: arrayFn.strings.length,
      wrapperAliases: aliasDeclarators.length,
      foldedCalls: folded
    }
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `使い方:
  node strip-string-obfuscation.js <input.js> [-o <output.js>] [--stats]
  node strip-string-obfuscation.js --batch <indir> -o <outdir> [options]

オプション:
  -o, --out <path>       出力先。単一ファイルで省略すると stdout。
      --batch <dir>      ディレクトリ一括処理（-o は必須）
      --ext <suffix>     入力として拾う拡張子。既定 .js
      --suffix <suffix>  出力ファイル名の拡張子。既定 .js
      --continue-on-error 失敗しても続行し、最後にサマリを出す
      --timeout <ms>     デコーダ評価のタイムアウト。既定 5000
      --stats            処理内容の内訳を stderr に出す
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
  const result = stripStringObfuscation(code, { timeout: opts.timeout });

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

  // --- バッチ ---
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

  // --- 単一ファイル ---
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

// 姉妹スクリプト（../dedebug/strip-debug-protection.js）が「文字列を読むだけ」に使うため、
// 部品の検出器とデコーダ評価も export する。剥がす処理はここにしかない。
module.exports = {
  stripStringObfuscation,
  StripError,
  matchStringArrayFunction,
  matchDecoderFunction,
  matchRotatorStatement,
  buildDecoder,
  literalArgValue
};

if (require.main === module) {
  main();
}
