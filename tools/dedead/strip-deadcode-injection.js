#!/usr/bin/env node
'use strict';

/**
 * strip-deadcode-injection.js
 *
 * javascript-obfuscator (obfuscator.io) が掛けた難読化のうち、
 * **deadcode-injection の層だけ**を決定論的に剥がす。
 * 姉妹ツール ../destring/strip-string-obfuscation.js の deadcode 版で、
 * ../../deobfuscate.js が掛ける 6 段のうち 2 段目。
 *
 * 難読化器が入れる形（BlockStatementDeadCodeInjectionNode.getNodeStructure）:
 *
 *   const isEq = random() > .5, isSame = random() > .5;
 *   const op    = isEq ? '===' : '!==';
 *   const left  = randomString(5);                 // pool は [a-zA-Z]
 *   const right = isSame ? left : randomString(5);
 *   const [cons, alt] = (isEq === isSame) ? [元のブロック, 死コード] : [死コード, 元のブロック];
 *   return [ blockStatement([ ifStatement(binary(op, lit(left), lit(right)), cons, alt) ]) ];
 *
 * つまり **元のブロックが `{ if('AbCdE' === 'FgHiJ') { 本物 } else { 死コード } }` に
 * 丸ごと置き換わる**。4 通りを展開すると真になる枝は必ず「元のブロック」側になる。
 * 述語は 5 文字のランダム英字同士の === / !== で、定数畳み込みで必ず真偽が決まる。
 *
 * 難読化器の側で保証されていること（dist/index.js を読んで確認）:
 *   - 述語は BinaryExpression のみ。ConditionalExpression にはならない。
 *   - 文字列長は常に 5、文字種は [a-zA-Z]。
 *   - 両枝は必ず BlockStatement。
 *   - 収集対象ブロックから FunctionDeclaration / break / continue / await / yield /
 *     super / arguments を含むものは除外される。つまり**死枝に関数宣言や
 *     break/continue は入らない**。
 *   - 死コードのクローンは function で包み直して識別子をリネームしてから埋めるので、
 *     死枝の var 名が外から参照されることはない。
 *   それでも安全弁は残す。入力が本当に obfuscator.io 由来かは検証していないため。
 *
 * 剥がすもの:
 *   偽になる枝と、それを選ぶための if と述語。
 *   `{ if(P){A}else{B} }` → `{A}`（親ブロックごと置換 = 正確な逆変換）。
 *
 * 触らないもの（= 残り 6 変換はそのまま残る）:
 *   string-obfuscation の文字列配列（述語に使われていた 5 文字文字列が配列に
 *   残るのは正しい）/ control-flow-flattening の辞書オブジェクト /
 *   debug-protection / self-defending / name-obfuscation の 16 進識別子 / code-compact。
 *
 *   ★ CFF の辞書エントリは、死枝でしか使われていないように見えても消してはいけない。
 *     難読化器は usingExistingIdentifierChance = 0.5 で既存エントリを使い回すので、
 *     同じエントリが生きたコードから参照されていることがある。
 *
 * ★ 文字列は「読む」が「書き戻さない」。
 *   7 変換同時では述語が二重に間接化されていて、生のファイルに
 *   「文字列リテラル同士の比較」は 1 つも現れない（実測 0 件）。
 *
 *     生ファイル       if(_0x52101a[_0x2ff2e1(0x223)](_0x2ff2e1(0x1f2),_0x52101a[_0x2ff2e1(0x1da)])){A}else{B}
 *     string 層を解くと if(_0x52101a['PHazP']('odjtH',_0x52101a['CzTAH'])){A}else{B}
 *       _0x52101a['PHazP'] => function(a,b){return _0x3f2479['NIrpW'](a,b);}
 *       _0x3f2479['NIrpW'] => function(a,b){return a===b;}
 *       _0x52101a['CzTAH'] => 'odjtH'                      → true → A が本物
 *
 *   検出のために ../destring の部品を借りてデコーダを vm 上に組み立て、
 *   control-flow-flattening の辞書も畳んで値を求める。
 *   求めた値は判定にしか使わない。出力の文字列表現は 1 バイトも変えない。
 *
 * ★ 生きた枝のブロックは展開しない。
 *   (a) 展開すると let / const / class が外側スコープへ出て再宣言衝突を起こしうる。
 *   (b) 難読化器は**関数本体の BlockStatement も置換対象にする**ので、
 *       `function f(){'use strict';..}` は `function f(){if(P){'use strict';..}else{..}}`
 *       になり得る。この 'use strict' はもう directive ではない。ブロックを外して
 *       関数本体の先頭へ戻すと strict モードが復活して意味が変わる。
 *
 * ★ 出力は 1 行 compact のまま。整形して出してはいけない。
 *   (a) code-compact まで解除したことになる。
 *   (b) self-defending は fn.toString().search('(((.+)+)+)+$') で整形を検出する。
 *       改行が入ると catastrophic backtracking で事実上ハングする。
 *
 * ★ 安全弁の方針は destring と違う。
 *   destring は畳み込みに失敗すると壊れたコードが出るので「確信が持てなければ失敗」。
 *   このツールは**死枝を残しても出力は正しく動く**（剥がし残しになるだけ）ので、
 *   「確信が持てない if は触らずに続行」が正しい。数は --stats に出す。
 *   ハード失敗させるのは次の 3 つだけ:
 *     - 生成したコードがパースできない
 *     - 自己検査（ノード種別ヒストグラムの等式・出力が入力の部分列であること）が破れた
 *     - --require-all 指定時に解決できない候補が残った
 *
 * ★ ../destring とは node_modules が別実体になる。境界を越えてよいのは
 *   プレーンな AST ノードと値だけ。NodePath / Scope / traverse は必ず自分側の
 *   @babel で扱う（借りているのは match* / buildDecoder / literalArgValue の 4 つだけで、
 *   いずれもノードを取って値を返す関数）。
 *
 * 未対応（安全に「解決できない」と扱って剥がし残す）:
 *   transformObjectKeys: true  — 辞書が var s={}; s['a']=.. になり引けない
 *   simplify: true             — if が三項に畳まれて両枝 BlockStatement の前提が崩れる
 *   stringArrayCallsTransform / base64・rc4 — デコーダを組み立てられない
 */

const fs = require('fs');
const path = require('path');

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const destring = require('../destring/strip-string-obfuscation.js');

const PARSER_OPTIONS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  errorRecovery: false
};

const GENERATE_OPTIONS = {
  compact: true,
  comments: false,
  jsescOption: { quotes: 'single', wrap: true }
};

/** 難読化器が使う述語文字列の形。RandomGenerator の pool は英大小文字のみ、長さは常に 5。 */
const PREDICATE_RE = /^[A-Za-z]{5}$/;

/** 辞書関数の委譲をたどる深さの上限。 */
const MAX_DEPTH = 24;

/** ラッパー別名を集める不動点反復の上限。 */
const MAX_PASSES = 16;

class StripError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripError';
  }
}

// ---------------------------------------------------------------------------
// 文字列の読み取り（判定専用。コードは書き換えない）
// ---------------------------------------------------------------------------

/**
 * string-obfuscation のデコーダを ../destring から借りる。
 *
 * 組み立てられなくても失敗にしない。読めない述語が増えて剥がし残るだけなので、
 * 理由を stats に出して続行する。
 *
 * @returns {{decode: Function|null, aliasBindings: Set, stringArrayPresent: boolean,
 *            decoderName: string|null, decoderIssue: string|null}}
 */
function borrowDecoder(ast, programScope, timeoutMs) {
  const none = {
    decode: null,
    aliasBindings: new Set(),
    stringArrayPresent: false,
    decoderName: null,
    decoderIssue: null
  };

  let arrayFn = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (arrayFn) return;
      const m = destring.matchStringArrayFunction(p.node);
      if (m) arrayFn = { ...m, path: p };
    }
  });

  // string-obfuscation が掛かっていない入力（既に剥がしたあと、あるいは掛けていない）。
  if (!arrayFn) return none;

  const degraded = (issue) => ({ ...none, stringArrayPresent: true, decoderIssue: issue });

  let decoderFn = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (decoderFn) return;
      const m = destring.matchDecoderFunction(p.node, arrayFn.name);
      if (m) decoderFn = { ...m, path: p };
    }
  });

  if (!decoderFn) {
    return degraded(
      `文字列配列関数 ${arrayFn.name} は見つかったがデコーダ関数が見つからない` +
        '（stringArrayCallsTransform など未対応の設定）'
    );
  }

  let rotatorPath = null;
  traverse(ast, {
    ExpressionStatement(p) {
      if (rotatorPath) return;
      if (destring.matchRotatorStatement(p.node, arrayFn.name)) rotatorPath = p;
    }
  });

  const decoderBinding = programScope.getBinding(decoderFn.name);
  if (!decoderBinding) return degraded(`デコーダ ${decoderFn.name} の束縛を解決できない`);

  // ラッパー別名を不動点で集める（stringArrayWrappersChainedCalls で多段になる）
  const aliasBindings = new Set([decoderBinding]);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
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

  let decode;
  try {
    decode = destring.buildDecoder(
      arrayFn.path.node,
      decoderFn.path.node,
      rotatorPath ? rotatorPath.node : null,
      decoderFn.name,
      timeoutMs
    );
  } catch (err) {
    return degraded(`デコーダを組み立てられない: ${err.message}`);
  }

  return {
    decode,
    aliasBindings,
    stringArrayPresent: true,
    decoderName: decoderFn.name,
    decoderIssue: null
  };
}

/**
 * 述語を読むための小さな評価器。
 *
 * 扱うのは「文字列・真偽に落ちる式」だけ:
 *   リテラル / デコーダ呼び出し / 辞書参照 DICT['KEY'] /
 *   辞書に入った 1 行 return の関数呼び出し DICT['KEY'](a, b) / === !== + 。
 *
 * control-flow-flattening は述語の文字列を辞書に吸い出したうえ、比較そのものも
 * 辞書の中の関数へ移す。しかもその関数が別の辞書の関数へ委譲することがあるので
 * 再帰で追う。委譲先の解決は「辞書が定義されたスコープ」で、実引数の解決は
 * 「呼び出し側のスコープ」で行う。
 */
function buildEvaluator(decode, aliasBindings, stats) {
  const FAIL = { ok: false };
  const dictCache = new Map(); // Binding -> ObjectExpression path | null

  // 述語を読むあいだは true。素の Identifier を束縛経由で辿らなくする。
  let noIdentifierLookup = false;

  /**
   * Identifier が「再代入されず、プロパティにも書き込まれない、
   * オブジェクトリテラル初期化の束縛」ならその ObjectExpression path を返す。
   *
   * プロパティ書き込みの検査は transformObjectKeys: true（var s={}; s['a']=..）を
   * 誤って読まないため。
   */
  function dictionaryOf(objPath) {
    if (!objPath.isIdentifier()) return null;
    const binding = objPath.scope.getBinding(objPath.node.name);
    if (!binding) return null;
    if (dictCache.has(binding)) return dictCache.get(binding);

    let result = null;
    if (binding.constant && binding.path.isVariableDeclarator() && t.isObjectExpression(binding.path.node.init)) {
      const written = binding.referencePaths.some((ref) => {
        const member = ref.parentPath;
        if (!member || !member.isMemberExpression() || member.node.object !== ref.node) return false;
        const owner = member.parentPath;
        if (!owner) return false;
        if (owner.isAssignmentExpression() && owner.node.left === member.node) return true;
        if (owner.isUpdateExpression()) return true;
        if (owner.isUnaryExpression({ operator: 'delete' })) return true;
        return false;
      });
      if (!written) result = binding.path.get('init');
    }

    dictCache.set(binding, result);
    if (result) stats.storages.add(binding);
    return result;
  }

  /** 辞書からキー key のプロパティ値 path を取り出す。 */
  function dictionaryProperty(dictPath, key) {
    for (const prop of dictPath.get('properties')) {
      if (!prop.isObjectProperty()) continue;
      const k = prop.node.key;
      const name =
        t.isIdentifier(k) && !prop.node.computed ? k.name : t.isStringLiteral(k) ? k.value : null;
      if (name === key) return prop.get('value');
    }
    return null;
  }

  /** MemberExpression（DICT['KEY'] / DICT.KEY）の指す値 path を返す。 */
  function memberTarget(memberPath, env, depth) {
    if (!memberPath || !memberPath.isMemberExpression()) return null;
    const dict = dictionaryOf(memberPath.get('object'));
    if (!dict) return null;
    let key;
    if (memberPath.node.computed) {
      const k = evaluate(memberPath.get('property'), env, depth + 1);
      if (!k.ok || typeof k.value !== 'string') return null;
      key = k.value;
    } else if (t.isIdentifier(memberPath.node.property)) {
      key = memberPath.node.property.name;
    } else {
      return null;
    }
    return dictionaryProperty(dict, key);
  }

  /**
   * 関数（arrow の式本体 or 末尾 return のブロック）の戻り式 path を返す。
   *
   * 7 変換同時では、辞書に入った比較関数の本体が 1 文ではなく
   *   function(a,b){ const D=_0x1a07; return DICT[D(0x171)](a,b); }
   * のように**デコーダ別名の宣言 + return** の 2 文になる。
   * 先頭の変数宣言は読み飛ばして末尾の return を見る（宣言自体は
   * 戻り式を評価するときに scope.getBinding 経由で解決される）。
   */
  function returnExpression(fnPath) {
    if (!fnPath.isFunctionExpression() && !fnPath.isArrowFunctionExpression()) return null;
    const body = fnPath.get('body');
    if (!body.isBlockStatement()) return body;
    const stmts = body.get('body');
    if (!stmts.length) return null;
    const last = stmts[stmts.length - 1];
    if (!last.isReturnStatement()) return null;
    if (!stmts.slice(0, -1).every((st) => st.isVariableDeclaration())) return null;
    const arg = last.get('argument');
    return arg.node ? arg : null;
  }

  /**
   * 式を評価する。env は仮引数名 -> 値（辞書に入った関数を畳むときに使う）。
   * @returns {{ok: boolean, value?: *}}
   */
  function evaluate(nodePath, env = new Map(), depth = 0) {
    if (!nodePath || !nodePath.node) return FAIL;
    if (depth > MAX_DEPTH) return FAIL;
    const node = nodePath.node;

    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) {
      return { ok: true, value: node.value };
    }

    if (t.isIdentifier(node)) {
      if (env.has(node.name)) return { ok: true, value: env.get(node.name) };
      // 難読化器は述語の値を「リテラル・デコーダ呼び出し・辞書参照」でしか書かない。
      // 素の変数を束縛経由で辿ると、利用者コードの
      //   const A='alpha', B='bravo'; if(A===B){..}else{..}
      // を deadcode と誤認する。述語を読むときは辿らない。
      if (noIdentifierLookup) return FAIL;
      const binding = nodePath.scope.getBinding(node.name);
      if (!binding || !binding.constant || !binding.path.isVariableDeclarator()) return FAIL;
      const init = binding.path.node.init;
      if (!init) return FAIL;
      // オブジェクト・関数そのものは値にしない（参照側・呼び出し側で処理する）
      if (t.isObjectExpression(init) || t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
        return FAIL;
      }
      return evaluate(binding.path.get('init'), new Map(), depth + 1);
    }

    if (t.isBinaryExpression(node)) {
      const l = evaluate(nodePath.get('left'), env, depth + 1);
      if (!l.ok) return FAIL;
      const r = evaluate(nodePath.get('right'), env, depth + 1);
      if (!r.ok) return FAIL;
      switch (node.operator) {
        case '===':
          return { ok: true, value: l.value === r.value };
        case '!==':
          return { ok: true, value: l.value !== r.value };
        case '+':
          // splitStrings: true で 5 文字述語が 'ab'+'cde' に割れることがある
          return { ok: true, value: l.value + r.value };
        default:
          return FAIL;
      }
    }

    if (t.isMemberExpression(node)) {
      const target = memberTarget(nodePath, env, depth);
      if (!target) return FAIL;
      return evaluate(target, new Map(), depth + 1);
    }

    if (t.isCallExpression(node)) {
      // デコーダ呼び出し D(0x118)
      if (t.isIdentifier(node.callee)) {
        if (!decode) return FAIL;
        const binding = nodePath.scope.getBinding(node.callee.name);
        if (!binding || !aliasBindings.has(binding)) return FAIL;
        const args = [];
        for (const a of node.arguments) {
          const lit = destring.literalArgValue(a);
          if (!lit.ok) return FAIL;
          args.push(lit.value);
        }
        try {
          const v = decode.apply(null, args);
          return typeof v === 'string' ? { ok: true, value: v } : FAIL;
        } catch (_) {
          return FAIL;
        }
      }

      // 辞書に入った関数の呼び出し DICT['KEY'](a, b)
      const fnPath = memberTarget(nodePath.get('callee'), env, depth);
      if (!fnPath) return FAIL;
      const ret = returnExpression(fnPath);
      if (!ret) return FAIL;

      const params = fnPath.node.params;
      if (!params.every((prm) => t.isIdentifier(prm))) return FAIL;
      if (node.arguments.length < params.length) return FAIL;

      // 実引数は呼び出し側の env で、関数本体は差し替えた env だけで評価する
      const inner = new Map();
      const argPaths = nodePath.get('arguments');
      for (let i = 0; i < params.length; i++) {
        const a = evaluate(argPaths[i], env, depth + 1);
        if (!a.ok) return FAIL;
        inner.set(params[i].name, a.value);
      }
      if (depth + 1 > stats.maxDelegationDepth) stats.maxDelegationDepth = depth + 1;
      return evaluate(ret, inner, depth + 1);
    }

    return FAIL;
  }

  /** 述語を読むための評価。素の変数は辿らない。 */
  evaluate.predicate = (nodePath) => {
    noIdentifierLookup = true;
    try {
      return evaluate(nodePath);
    } finally {
      noIdentifierLookup = false;
    }
  };

  return evaluate;
}

// ---------------------------------------------------------------------------
// deadcode の判定
// ---------------------------------------------------------------------------

/**
 * if の述語が「5 文字英字同士の === / !==」に畳めるなら、その真偽と述語の形を返す。
 *
 * 両辺が 5 文字の英字であることまで確かめる。難読化器はそこしか作らないので、
 * これで利用者コードの本物の if（たまたま定数比較になっているもの）を巻き込まない。
 *
 * @returns {{value: boolean, form: string}|null}
 */
function resolvePredicate(testPath, evaluate) {
  const node = testPath.node;

  const bothArePredicateStrings = (l, r) =>
    l.ok &&
    r.ok &&
    typeof l.value === 'string' &&
    typeof r.value === 'string' &&
    PREDICATE_RE.test(l.value) &&
    PREDICATE_RE.test(r.value);

  // 形 1: 直接の比較。CFF が掛かっていないか、掛かっても畳まれなかった部分。
  if (t.isBinaryExpression(node) && (node.operator === '===' || node.operator === '!==')) {
    const l = evaluate.predicate(testPath.get('left'));
    const r = evaluate.predicate(testPath.get('right'));
    if (!bothArePredicateStrings(l, r)) return null;
    const value = node.operator === '===' ? l.value === r.value : l.value !== r.value;
    const form = t.isStringLiteral(node.left) && t.isStringLiteral(node.right) ? 'literal' : 'dictLiteral';
    return { value, form };
  }

  // 形 2: CFF が比較そのものを辞書の関数へ移した形 DICT['KEY'](left, right)
  //       BinaryExpressionControlFlowReplacer の引数順は必ず (left, right)。
  if (t.isCallExpression(node) && node.arguments.length === 2) {
    const argPaths = testPath.get('arguments');
    const l = evaluate.predicate(argPaths[0]);
    const r = evaluate.predicate(argPaths[1]);
    if (!bothArePredicateStrings(l, r)) return null;

    const whole = evaluate.predicate(testPath);
    if (!whole.ok || typeof whole.value !== 'boolean') return null;
    return { value: whole.value, form: 'dictCall' };
  }

  return null;
}

/**
 * 難読化器が作る形かどうかの構造ガード。
 *
 * deadCodeInjection は `{ if(P){A}else{B} }` という 1 文だけのブロックを作る。
 * そのあと control-flow-flattening が同じブロックの先頭に storage 宣言を
 * 差し込むことがあるので、「if が親ブロックの最後の文で、それ以前は全部
 * 変数宣言」までを許す。実測 345/345 がこの形に収まる。
 */
function hasInjectedShape(ifPath) {
  const parent = ifPath.parentPath;
  if (!parent || !parent.isBlockStatement()) return false;
  const body = parent.node.body;
  if (body[body.length - 1] !== ifPath.node) return false;
  return body.slice(0, -1).every((stmt) => t.isVariableDeclaration(stmt));
}

/**
 * 死枝に含まれる var / function 宣言の名前が、枝の外から参照されているか。
 *
 * 参照されていると、枝を消したときに「元は undefined」だったものが
 * ReferenceError になる。そういう if は触らない。
 */
function deadBranchLeaksBinding(deadPath) {
  const names = new Set();
  deadPath.traverse({
    VariableDeclaration(p) {
      if (p.node.kind !== 'var') return;
      for (const d of p.node.declarations) {
        if (t.isIdentifier(d.id)) names.add(d.id.name);
      }
    },
    FunctionDeclaration(p) {
      if (p.node.id) names.add(p.node.id.name);
    }
  });
  if (!names.size) return false;

  const isInside = (p) => {
    let cur = p;
    while (cur) {
      if (cur.node === deadPath.node) return true;
      cur = cur.parentPath;
    }
    return false;
  };

  for (const name of names) {
    const binding = deadPath.scope.getBinding(name);
    if (!binding) continue;
    for (const ref of binding.referencePaths.concat(binding.constantViolations)) {
      if (!isInside(ref)) return true;
    }
  }
  return false;
}

/** 生きた枝を関数本体へ戻すと directive が復活しないか。'use strict' の昇格を防ぐ。 */
function liveBranchStartsWithDirectiveLike(liveNode) {
  const first = liveNode.body[0];
  return Boolean(first && t.isExpressionStatement(first) && t.isStringLiteral(first.expression));
}

/** 部分木のノード種別ヒストグラムを取る。 */
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

/** a に b を足し込む。 */
function addHistogram(a, b) {
  for (const [k, v] of Object.entries(b)) a[k] = (a[k] || 0) + v;
  return a;
}

/** short が long の「文字単位の部分列」か。1 文字も足していないことの証明に使う。 */
function isSubsequence(short, long) {
  let i = 0;
  for (let j = 0; j < long.length && i < short.length; j++) {
    if (short[i] === long[j]) i++;
  }
  return i === short.length;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * 1 パスぶんの除去。呼び出し側 (stripDeadCodeInjection) が変化が無くなるまで回す。
 *
 * @param {string} code
 * @param {{timeout?: number, strictShape?: boolean, selfCheck?: boolean}} options
 * @returns {{code: string, changed: boolean, removedTypeCounts: object, stats: object}}
 */
function stripOnce(code, options = {}) {
  const timeoutMs = options.timeout || 5000;
  const strictShape = options.strictShape !== false;
  const selfCheck = options.selfCheck !== false;

  let ast;
  try {
    ast = parser.parse(code, PARSER_OPTIONS);
  } catch (err) {
    throw new StripError(`入力をパースできない: ${err.message}`);
  }

  let programPath = null;
  traverse(ast, {
    Program(p) {
      programPath = p;
      p.stop();
    }
  });

  const evalStats = { storages: new Set(), maxDelegationDepth: 0 };
  const { decode, aliasBindings, stringArrayPresent, decoderName, decoderIssue } = borrowDecoder(
    ast,
    programPath.scope,
    timeoutMs
  );
  const evaluate = buildEvaluator(decode, aliasBindings, evalStats);

  // --- 収集フェーズ -------------------------------------------------------
  // トップダウンに走査する。ヒットしたら生きた枝だけを追い、死枝には降りない
  // （どうせ消えるし、死枝の中のヒットを数えても意味がない）。
  // AST は一切変えないので、判定に使うスコープ情報は最後まで無傷のまま。
  const hits = [];
  const byPredicateForm = { literal: 0, dictLiteral: 0, dictCall: 0 };
  let candidates = 0;
  let unresolved = 0;
  let skippedShape = 0;
  let skippedLeak = 0;

  const collectIn = (root) => {
    root.traverse({
      IfStatement(p) {
        if (!p.node.alternate) return;
        if (!t.isBlockStatement(p.node.consequent) || !t.isBlockStatement(p.node.alternate)) return;

        candidates += 1;

        const verdict = resolvePredicate(p.get('test'), evaluate);
        if (!verdict) {
          unresolved += 1;
          // DEDEAD_DEBUG=1 で「解決できなかった述語」を並べる。
          // 本物の if なのか、読めていないだけなのかを目で確かめるための口。
          if (process.env.DEDEAD_DEBUG) {
            process.stderr.write(
              `  unresolved: ${generate(p.node.test, { compact: true }).code.slice(0, 160)}\n`
            );
          }
          return; // 本物の if かもしれない。そのまま降りて内側を見る
        }

        if (strictShape && !hasInjectedShape(p)) {
          skippedShape += 1;
          return;
        }

        const livePath = verdict.value ? p.get('consequent') : p.get('alternate');
        const deadPath = verdict.value ? p.get('alternate') : p.get('consequent');

        if (deadBranchLeaksBinding(deadPath)) {
          skippedLeak += 1;
          return;
        }

        const parent = p.parentPath;
        // 難読化器が作る形は BlockStatement{ IfStatement }。その形なら親ブロック
        // ごと戻すのが正確な逆変換になる。ただし親ブロックが関数本体などになる
        // 位置で、生きた枝が文字列文で始まっていると directive が復活するので避ける。
        const replaceParent =
          parent.isBlockStatement() &&
          parent.node.body.length === 1 &&
          parent.node.body[0] === p.node &&
          !parent.parentPath.isProgram() &&
          !liveBranchStartsWithDirectiveLike(livePath.node);

        // 除去されるノードを、変形前の無傷な部分木で数えておく
        const removed = addHistogram(
          typeHistogram([p.node.test, deadPath.node]),
          { IfStatement: 1 }
        );
        if (replaceParent) addHistogram(removed, { BlockStatement: 1 });

        hits.push({ path: p, parent, livePath, replaceParent, removed });
        byPredicateForm[verdict.form] += 1;

        // 生きた枝の内側にもう一段入っていることがある
        collectIn(livePath);
        p.skip();
      }
    });
  };
  collectIn(programPath);

  const stats = {
    stringArrayPresent,
    decoder: decoderName,
    decoderIssue,
    storages: evalStats.storages.size,
    maxDelegationDepth: evalStats.maxDelegationDepth,
    candidates,
    resolved: hits.length,
    removed: 0,
    unresolved,
    skippedShape,
    skippedLeak,
    byPredicateForm,
    shape: { parentBlock: 0, ifOnly: 0 },
    passes: 1,
    bytes: { in: code.length, out: code.length }
  };

  if (!hits.length) {
    // 何も見つからなかった入力は 1 バイトも変えずに通す（冪等を自明にする）。
    return { code, changed: false, removedTypeCounts: {}, stats };
  }

  // --- 適用フェーズ -------------------------------------------------------
  // 収集は外側 → 内側の順なので、内側から適用すれば外側の path が生きたまま残る。
  const removedTypeCounts = Object.create(null);
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i];
    const liveNode = hit.livePath.node;
    if (hit.replaceParent) {
      hit.parent.replaceWith(liveNode);
      stats.shape.parentBlock += 1;
    } else {
      hit.path.replaceWith(liveNode);
      stats.shape.ifOnly += 1;
    }
    addHistogram(removedTypeCounts, hit.removed);
  }
  stats.removed = hits.length;

  const out = generate(ast, GENERATE_OPTIONS).code;

  try {
    parser.parse(out, PARSER_OPTIONS);
  } catch (err) {
    throw new StripError(`生成したコードがパースできない: ${err.message}`);
  }

  // --- 自己検査 -----------------------------------------------------------
  // ここが破れたら「deadcode 層だけを剥がした」と言えないので、黙って出さない。
  if (selfCheck) {
    const baseline = generate(parser.parse(code, PARSER_OPTIONS), GENERATE_OPTIONS).code;

    if (!isSubsequence(out, baseline)) {
      throw new StripError(
        '自己検査に失敗: 出力が入力の部分列になっていない（削除以外の変更が入っている）'
      );
    }

    const before = typeHistogram([parser.parse(baseline, PARSER_OPTIONS).program]);
    const after = typeHistogram([parser.parse(out, PARSER_OPTIONS).program]);
    const drift = [];
    for (const type of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const expected = (before[type] || 0) - (removedTypeCounts[type] || 0);
      const actual = after[type] || 0;
      if (expected !== actual) drift.push(`${type}: 期待 ${expected} / 実際 ${actual}`);
    }
    if (drift.length) {
      throw new StripError(
        `自己検査に失敗: 除去した部分木以外のノードが動いている\n  ${drift.join('\n  ')}`
      );
    }
  }

  stats.bytes.out = out.length;
  return { code: out, changed: true, removedTypeCounts, stats };
}

/**
 * コードから deadcode-injection の層だけを剥がす。
 *
 * 1 パスでは取りこぼすことがあるので、変化が無くなるまで回す。
 * 死枝を消したことで「枝の外からの参照」が消え、前のパスで安全弁に引っかかった
 * if が次のパスでは剥がせるようになる（実測あり）。
 * 回し切ることで「もう一度掛けても何も起きない」ことが保証される。
 *
 * @param {string} code
 * @param {{timeout?: number, strictShape?: boolean, requireAll?: boolean, selfCheck?: boolean}} options
 * @returns {{code: string, changed: boolean, removedTypeCounts: object, stats: object}}
 */
function stripDeadCodeInjection(code, options = {}) {
  let current = code;
  let total = null;
  const removedTypeCounts = Object.create(null);
  let passes = 0;

  for (; passes < MAX_PASSES; passes++) {
    const r = stripOnce(current, options);

    if (!total) {
      total = r.stats;
    } else {
      // パスをまたいで足す。candidates = resolved + unresolved + skipped* の等式は保たれる。
      for (const k of ['candidates', 'resolved', 'removed', 'unresolved', 'skippedShape', 'skippedLeak']) {
        total[k] += r.stats[k];
      }
      for (const k of Object.keys(total.byPredicateForm)) total.byPredicateForm[k] += r.stats.byPredicateForm[k];
      total.shape.parentBlock += r.stats.shape.parentBlock;
      total.shape.ifOnly += r.stats.shape.ifOnly;
      total.storages = Math.max(total.storages, r.stats.storages);
      total.maxDelegationDepth = Math.max(total.maxDelegationDepth, r.stats.maxDelegationDepth);
    }
    addHistogram(removedTypeCounts, r.removedTypeCounts);

    if (!r.changed) break;
    current = r.code;
  }

  total.passes = passes + 1;
  total.bytes = { in: code.length, out: current.length };

  if (options.requireAll && total.unresolved > 0) {
    throw new StripError(`--require-all: 解決できない候補が ${total.unresolved} 件残っている`);
  }

  return { code: current, changed: current !== code, removedTypeCounts, stats: total };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `使い方:
  node strip-deadcode-injection.js <input.js> [-o <output.js>] [--stats]
  node strip-deadcode-injection.js --batch <indir> -o <outdir> [options]

オプション:
  -o, --out <path>       出力先。単一ファイルで省略すると stdout。
      --batch <dir>      ディレクトリ一括処理（-o は必須）
      --ext <suffix>     入力として拾う拡張子。既定 .js
      --suffix <suffix>  出力ファイル名の拡張子。既定 .js
      --continue-on-error 失敗しても続行し、最後にサマリを出す
      --timeout <ms>     デコーダ評価のタイムアウト。既定 5000
      --no-strict-shape  難読化器が作る形（1 文だけのブロック）以外の if も対象にする
      --require-all      解決できない候補が残ったら非ゼロ終了する
      --no-self-check    出力の自己検査（部分列性・ノード会計）を省く
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
    strictShape: true,
    requireAll: false,
    selfCheck: true,
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
    } else if (a === '--no-strict-shape') {
      opts.strictShape = false;
    } else if (a === '--require-all') {
      opts.requireAll = true;
    } else if (a === '--no-self-check') {
      opts.selfCheck = false;
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
  const result = stripDeadCodeInjection(code, {
    timeout: opts.timeout,
    strictShape: opts.strictShape,
    requireAll: opts.requireAll,
    selfCheck: opts.selfCheck
  });

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

module.exports = {
  stripDeadCodeInjection,
  StripError,
  PREDICATE_RE,
  PARSER_OPTIONS,
  GENERATE_OPTIONS,
  isSubsequence,
  typeHistogram
};

if (require.main === module) {
  main();
}
