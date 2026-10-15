#!/usr/bin/env node
'use strict';

/**
 * strip-code-compact.js
 *
 * javascript-obfuscator (obfuscator.io) が掛けた難読化のうち、
 * **code-compact の層だけ**を決定論的に剥がす。
 *
 * code-compact は変換ではなく**コード生成オプション** `compact: true` ただ1つで、
 * 空白・改行・インデントを落とすだけ（JsDeObsBench の code-compact 単体の設定も、
 * 既定との差分は "compact": true のみ）。したがって解除は **整形のみ**になる。
 *
 * ★ 触ってはいけないもの（どれも code-compact ではなく別の層 / 常時オンの変換）:
 *     obj['method'] のブラケット記法 / 0x1f の16進リテラル / '\x0a' のエスケープ /
 *     _0x1a2b3c の16進識別子。これらは compact:false の出力にもそのまま現れる。
 *
 * ★ 整形は「難読化器が compact:false で出したはずのコード」を再現する。
 *   javascript-obfuscator 自身が使う @javascript-obfuscator/escodegen で生成するので、
 *   self-defending を含まない構成では**バイト単位で一致**する（verify.js の gold 検査）。
 *   escodegen に parse オプションを渡さないと 0x92 が 146 になり16進リテラルが壊れるので必須。
 *
 * ★ 既定の出力は 7 変換入力では**実行するとハングする**。不具合ではない。
 *   self-defending は SelfDefendingTemplate の
 *     X.toString().search('(((.+)+)+)+$')
 *   で整形を検出する仕掛けで、改行が入ると `.` が改行を跨げず
 *   catastrophic backtracking になる。code-compact と self-defending は
 *   独立に剥がせない（ルートの README「なぜこの順序か」）。
 *   --keep-self-defending を付けると検査対象の関数だけ 1 行に残し、実行可能にする。
 *
 * ★ 安全弁: 少しでも確信が持てない状況（パース失敗、出力の再パース失敗、
 *   入力と出力の AST 不一致、保護対象が見つからない）では出力せず非ゼロ終了する。
 *   黙って壊れたコードを出さない。
 */

const fs = require('fs');
const path = require('path');

const acorn = require('acorn');
const escodegen = require('@javascript-obfuscator/escodegen');

/** self-defending が整形を検出するのに使う正規表現（文字列リテラルとして現れる） */
const SELF_DEFENDING_MARK = '(((.+)+)+)+$';

const ACORN_BASE = {
  ecmaVersion: 'latest',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
  preserveParens: false
};

/** AST 比較で無視するキー（位置情報と、こちらが付けた生成ヒント） */
const IGNORED_KEYS = new Set(['start', 'end', 'loc', 'range', 'x-verbatim-property']);

/** 安全弁が発火したときに投げる。CLI 側で理由つきの失敗として扱う。 */
class StripError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripError';
  }
}

// ---------------------------------------------------------------------------
// パースと生成
// ---------------------------------------------------------------------------

/**
 * script として読み、駄目なら module として読む。
 * 成功した sourceType を返すので、出力の再パースを同じ条件で行える。
 */
function parseWith(code, sourceType) {
  const comments = [];
  const ast = acorn.parse(code, Object.assign({}, ACORN_BASE, { sourceType, onComment: comments }));
  return { ast, sourceType, comments };
}

function parseCode(code, sourceType) {
  if (sourceType) return parseWith(code, sourceType);
  try {
    return parseWith(code, 'script');
  } catch (scriptErr) {
    try {
      return parseWith(code, 'module');
    } catch (moduleErr) {
      throw new StripError(
        `入力がパースできない: script として ${scriptErr.message} / module として ${moduleErr.message}`
      );
    }
  }
}

/** escodegen の生成オプション。parse は16進・8進などの raw を保つために必須。 */
function escodegenOptions(sourceType, compact) {
  return {
    parse: (s) => acorn.parse(s, Object.assign({}, ACORN_BASE, { sourceType })),
    verbatim: 'x-verbatim-property',
    format: { compact: Boolean(compact) }
  };
}

// ---------------------------------------------------------------------------
// AST の比較（= 他の層に一切触れていないことの機械的な証明）
// ---------------------------------------------------------------------------

function describe(value) {
  if (value === null) return 'null';
  if (value instanceof RegExp) return `RegExp(${String(value)})`;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'object') return Array.isArray(value) ? `Array(${value.length})` : String(value.type || 'Object');
  return JSON.stringify(value);
}

/**
 * AST を深く比較する。位置情報だけを無視し、raw（リテラルの元の綴り）まで一致を要求する。
 * 整形はノードを 1 つも変えないので、ここは厳密一致でなければならない。
 * 不一致があれば最初に見つかった場所を返す（null なら一致）。
 */
function astDiff(a, b, pathStr) {
  if (a === b) return null;

  if (a instanceof RegExp || b instanceof RegExp) {
    if (a instanceof RegExp && b instanceof RegExp && String(a) === String(b)) return null;
    return `${pathStr}: ${describe(a)} != ${describe(b)}`;
  }

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // NaN 同士は等しいとみなす（リテラルには現れないが念のため）
    if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return null;
    return `${pathStr}: ${describe(a)} != ${describe(b)}`;
  }

  if (Array.isArray(a) !== Array.isArray(b)) return `${pathStr}: 配列と非配列`;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${pathStr}: 要素数 ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = astDiff(a[i], b[i], `${pathStr}[${i}]`);
      if (d) return d;
    }
    return null;
  }

  const keys = (o) => Object.keys(o).filter((k) => !IGNORED_KEYS.has(k) && o[k] !== undefined).sort();
  const ka = keys(a);
  const kb = keys(b);
  if (ka.join(',') !== kb.join(',')) {
    return `${pathStr}: キー集合が違う [${ka.join(',')}] != [${kb.join(',')}]`;
  }
  for (const k of ka) {
    const d = astDiff(a[k], b[k], `${pathStr}.${k}`);
    if (d) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// AST の走査
// ---------------------------------------------------------------------------

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (IGNORED_KEYS.has(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') walk(c, visit);
    } else if (child && typeof child.type === 'string') {
      walk(child, visit);
    }
  }
}

/** 文字列リテラルの値をすべて集める */
function stringLiteralValues(ast) {
  const found = new Set();
  walk(ast, (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string') found.add(n.value);
  });
  return found;
}

/**
 * self-defending が toString() で検査する関数を見つける。
 *
 * SingleCallControllerTemplate の
 *     const rfn = firstCall ? function(){ ... } : function(){}
 * の **consequent 側**がそれで、SelfDefendingTemplate が
 *     X.toString().search('(((.+)+)+)+$')
 * で調べるのはこの関数の原文。ここに改行が入ると catastrophic backtracking になる。
 *
 * control-flow-flattening や deadcode-injection が中に入り込んでも、
 * この三項演算子の形自体は残る（実測）。
 */
function findSelfDefendingGuards(ast) {
  const guards = [];
  walk(ast, (n) => {
    if (n.type !== 'ConditionalExpression') return;
    const { test, consequent, alternate } = n;
    if (!test || test.type !== 'Identifier') return;
    if (!consequent || consequent.type !== 'FunctionExpression' || consequent.params.length !== 0) return;
    if (!alternate || alternate.type !== 'FunctionExpression' || alternate.params.length !== 0) return;
    if (!alternate.body || alternate.body.body.length !== 0) return;
    guards.push(consequent);
  });
  return guards;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * リテラルとコメントの中を除いた「構造上の改行」を数える。
 * code-compact が掛かっているとここがちょうど 0 になる。
 *
 * ★ 素朴に改行を数えてはいけない。改行を含むテンプレートリテラルや文字列を持つ
 *   プログラムは、compact:true で出力してもソースに改行が現れる。
 *   それを「既に整形済み」と誤判定すると、黙って何もしないまま正常終了してしまう。
 */
function structuralNewlineCount(code, ast, comments) {
  const ranges = [];
  walk(ast, (n) => {
    if (n.type === 'TemplateElement') ranges.push([n.start, n.end]);
    else if (n.type === 'Literal' && (typeof n.value === 'string' || n.regex)) ranges.push([n.start, n.end]);
  });
  for (const c of comments || []) ranges.push([c.start, c.end]);
  ranges.sort((a, b) => a[0] - b[0]);

  const limit = code.replace(/\s+$/, '').length; // 末尾の改行は数えない
  let count = 0;
  let ri = 0;
  for (let i = 0; i < limit; i++) {
    const ch = code[i];
    if (ch !== '\n' && ch !== '\r') continue;
    while (ri < ranges.length && ranges[ri][1] <= i) ri += 1;
    if (ri < ranges.length && ranges[ri][0] <= i && i < ranges[ri][1]) continue;
    count += 1;
  }
  return count;
}

/** 入力に code-compact が掛かっているか */
function looksCompact(code, ast, comments) {
  return structuralNewlineCount(code, ast, comments) === 0;
}

/**
 * code-compact だけを剥がす。
 *
 * @param {string} code 難読化されたコード
 * @param {{keepSelfDefending?: boolean, force?: boolean}} options
 * @returns {{code: string, changed: boolean, warnings: string[], stats: object}}
 */
function stripCodeCompact(code, options) {
  const opts = options || {};
  const warnings = [];

  const { ast, sourceType, comments } = parseCode(code);

  const hasSelfDefendingMark = stringLiteralValues(ast).has(SELF_DEFENDING_MARK);

  // --- 対象なし: 既に整形されている（= code-compact が掛かっていない） ---
  const structuralNewlines = structuralNewlineCount(code, ast, comments);
  if (structuralNewlines > 0 && !opts.force) {
    return {
      code,
      changed: false,
      warnings,
      stats: {
        lines: code.split('\n').length,
        bytes: Buffer.byteLength(code, 'utf8'),
        guardsKept: 0,
        astIdentical: true,
        selfDefending: hasSelfDefendingMark,
        structuralNewlines,
        noop: true
      }
    };
  }

  // --- self-defending の検査対象を 1 行のまま残す ---
  let guardsKept = 0;
  if (opts.keepSelfDefending) {
    const guards = findSelfDefendingGuards(ast);
    if (guards.length === 0) {
      throw new StripError(
        '--keep-self-defending を指定したが、self-defending の検査対象関数が見つからなかった。' +
          '保護できないまま整形すると実行がハングするので出力しない。'
      );
    }
    const compactOptions = escodegenOptions(sourceType, true);
    for (const guard of guards) {
      guard['x-verbatim-property'] = {
        content: escodegen.generate(guard, compactOptions),
        precedence: escodegen.Precedence.Primary
      };
      guardsKept += 1;
    }
  } else if (hasSelfDefendingMark) {
    warnings.push(
      'self-defending の目印を検出した。この出力は実行するとハングする' +
        '（整形が fn.toString().search(' +
        JSON.stringify(SELF_DEFENDING_MARK) +
        ') に引っかかる）。実行したいなら --keep-self-defending を使うこと。'
    );
  }

  // --- 整形 ---
  let out;
  try {
    out = escodegen.generate(ast, escodegenOptions(sourceType, false));
  } catch (err) {
    throw new StripError(`整形に失敗した: ${err.message}`);
  }
  // ★ 末尾に改行を足さない。難読化器が compact:false で出すバイト列と一致させるため
  //    （verify.js の gold 検査がバイト比較なので、1 バイトでも足すと崩れる）。

  // --- 自己検査 1: 出力がパースできる ---
  let outAst;
  try {
    outAst = parseCode(out, sourceType).ast;
  } catch (err) {
    throw new StripError(`生成したコードがパースできない: ${err.message}`);
  }

  // --- 自己検査 2: 入力と出力の AST が完全に一致する ---
  //     整形はノードを 1 つも変えない。ここが「他 6 変換に触れていない」証明になる。
  const inputAst = parseCode(code, sourceType).ast;
  const diff = astDiff(inputAst, outAst, 'Program');
  if (diff) {
    throw new StripError(`整形前後で AST が変わった（別の層に触れている）: ${diff}`);
  }

  return {
    code: out,
    changed: true,
    warnings,
    stats: {
      lines: out.split('\n').length,
      bytes: Buffer.byteLength(out, 'utf8'),
      guardsKept,
      astIdentical: true,
      selfDefending: hasSelfDefendingMark,
      structuralNewlines,
      noop: false
    }
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `使い方:
  node strip-code-compact.js <input.js> [-o <output.js>] [--stats]
  node strip-code-compact.js --batch <indir> -o <outdir> [options]

オプション:
  -o, --out <path>          出力先。単一ファイルで省略すると stdout。
      --batch <dir>         ディレクトリ一括処理（-o は必須）
      --ext <suffix>        入力として拾う拡張子。既定 .js
      --suffix <suffix>     出力ファイル名の拡張子。既定 .js
      --continue-on-error   失敗しても続行し、最後にサマリを出す
      --keep-self-defending self-defending の検査対象関数だけ 1 行に残す。
                            出力が実行可能になる代わりに、その関数ぶんだけ
                            code-compact が残る。
      --force               入力が既に複数行でも整形する
      --stats               処理内容の内訳を stderr に出す
  -h, --help                このヘルプ

code-compact の解除は整形のみで、ブラケット記法・16進リテラル・\\x エスケープ・
16進識別子には触らない（どれも別の層）。
`;

function parseArgs(argv) {
  const opts = {
    input: null,
    out: null,
    batch: null,
    ext: '.js',
    suffix: '.js',
    continueOnError: false,
    keepSelfDefending: false,
    force: false,
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
    } else if (a === '--keep-self-defending') {
      opts.keepSelfDefending = true;
    } else if (a === '--force') {
      opts.force = true;
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
  const result = stripCodeCompact(code, {
    keepSelfDefending: opts.keepSelfDefending,
    force: opts.force
  });

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, result.code, 'utf8');
  } else {
    // 端末に出すときだけ末尾改行を補う（ファイルには足さない = バイト一致を保つ）
    process.stdout.write(result.code.endsWith('\n') ? result.code : result.code + '\n');
  }

  for (const w of result.warnings) {
    process.stderr.write(`[!] ${path.basename(inFile)}: ${w}\n`);
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

module.exports = { stripCodeCompact, StripError, SELF_DEFENDING_MARK, looksCompact, structuralNewlineCount };

if (require.main === module) {
  main();
}
