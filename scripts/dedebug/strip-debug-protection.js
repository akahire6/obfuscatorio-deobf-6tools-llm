#!/usr/bin/env node
'use strict';

/**
 * strip-debug-protection.js
 *
 * javascript-obfuscator (obfuscator.io) が掛けた難読化のうち、
 * **debug-protection の層だけ**を決定論的に剥がす。
 * 姉妹スクリプト ../destring/strip-string-obfuscation.js の debug-protection 版で、
 * ../../deobfuscate.js が掛ける 6 段のうち 5 段目。
 *
 * 剥がすもの（= debugProtection が生む 3 部品）:
 *   1. 本体            function DPF(ret){ function debuggerProtection(c){ ..
 *                        ['constructor']('debu'+'gger')['call']('action') ..
 *                        debuggerProtection(++c); } try{ .. }catch(y){} }
 *   2. 起動 IIFE       (function(){ C(this, function(){ .. DPF('init') .. })(); }())
 *                      （debugProtectionInterval > 0 なら setInterval(DPF, ms) も）
 *   3. calls-controller var C=(function(){var firstCall=!![];return function(ctx,fn){..}}())
 *                      ※ self-defending と共有されている場合は削除しない
 *
 * ★ 2 と 3 はトップレベルとは限らない。難読化器はユーザ関数の本体の中に
 *   注入することがある（実測: wordCount の中に入っていた）。だから「トップレベル文」
 *   ではなく「文リストの直下にある文」を単位に削除する。
 *
 * ★ control-flow-flattening が掛かっていると、文字列は辞書オブジェクト経由
 *   (_0x3f2479['pNevn'] や _0x3f2479['kYgwU']('debu', ..)) になる。
 *   小さな評価器を持ち、辞書・連結関数・デコーダ呼び出しを畳んで値を求める。
 *
 * 触らないもの（= 残り 6 変換はそのまま残る）:
 *   string-obfuscation の文字列配列（debug-protection が使っていた文字列が
 *   配列に残るのは正しい）/ deadcode-injection のダミー分岐 /
 *   control-flow-flattening の辞書オブジェクト / self-defending /
 *   name-obfuscation の 16 進識別子 / code-compact。
 *
 * ★ 文字列は「読む」が「書き戻さない」。
 *   7 変換同時では 'debu' / 'gger' / 'while (true) {}' が全部デコーダ呼び出しに
 *   なっていて見えない。検出のために ../destring の部品を借りてデコーダを
 *   vm 上に組み立て、値を照合する。出力の文字列表現は一切変えない。
 *
 * ★ 出力は 1 行 compact のまま。整形して出してはいけない。
 *   (a) code-compact まで解除したことになる。
 *   (b) self-defending は fn.toString().search('(((.+)+)+)+$') で整形を検出する。
 *       改行が入ると catastrophic backtracking で事実上ハングする。
 *
 * ★ 安全弁: 少しでも確信が持てない状況（候補が複数、削除範囲にユーザコードが
 *   混ざる、削除後も参照が残る、到達可能な debugger 生成が残る）では
 *   出力せず非ゼロ終了する。黙って壊れたコードを出さない。
 *
 * ★ deadcode-injection が debug-protection の断片を死んだ分岐にコピーしている
 *   ことがある。到達不能なので残し（deadcode 層を壊さないため）、
 *   stats.deadFragments に数を報告する。
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

/** debugProtection が Function コンストラクタに渡す本体。この 2 つが決定打になる。 */
const DEBUGGER_BODIES = new Set(['debugger', 'while (true) {}']);

/** 安全弁が発火したときに投げる。CLI 側で理由つきの失敗として扱う。 */
class StripError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripError';
  }
}

// ---------------------------------------------------------------------------
// 汎用
// ---------------------------------------------------------------------------

/** 部分木を歩く（@babel/traverse を使わない軽い走査）。 */
function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key of t.VISITOR_KEYS[node.type] || []) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => walk(c, fn));
    else if (child && typeof child.type === 'string') walk(child, fn);
  }
}

/** ノード群の種別ヒストグラムを取る（「何を消したか」を機械的に照合するため）。 */
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

/** walk と同じだが、入れ子の関数の中には降りない（その関数自身のスコープだけを見る）。 */
function walkOwnScope(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key of t.VISITOR_KEYS[node.type] || []) {
    const child = node[key];
    const step = (c) => {
      if (!c || typeof c.type !== 'string') return;
      if (t.isFunction(c)) return; // 入れ子の関数には降りない
      walkOwnScope(c, fn);
    };
    if (Array.isArray(child)) child.forEach(step);
    else step(child);
  }
}

/** path の祖先をたどって、node 集合のいずれかの内側にいるかを見る。 */
function isInsideAny(nodePath, nodes) {
  let cur = nodePath;
  while (cur) {
    if (nodes.has(cur.node)) return true;
    cur = cur.parentPath;
  }
  return false;
}

/**
 * path を含む「文リストの直下にある文」を、内側から外側へ順に返す。
 *
 * 難読化器は calls-controller と起動 IIFE をユーザ関数の本体に注入することがあるので、
 * 削除の単位はトップレベル文ではなく「Program か BlockStatement の直下の文」になる。
 * さらに起動 IIFE の中にも文があるため、どの深さの文を指すかは用途で決める。
 */
function listStatements(nodePath) {
  const out = [];
  let cur = nodePath;
  while (cur && cur.parentPath) {
    if (cur.parentPath.isProgram() || cur.parentPath.isBlockStatement()) out.push(cur);
    cur = cur.parentPath;
  }
  return out;
}

/** 一番内側の「文リスト直下の文」。宣言そのものを指したいときに使う。 */
function listStatement(nodePath) {
  const all = listStatements(nodePath);
  return all.length > 0 ? all[0] : null;
}

/**
 * obj['constructor'](x) / obj.constructor(x) の形なら第 1 引数の path を返す。
 *
 * プロパティ名自体が文字列配列に入る（obj[_0x1ed743(0x2c1)](x)）ことがあるので、
 * リテラルで一致しなければ解決器に掛ける。
 */
function constructorCallArgument(callPath, resolveString) {
  if (!callPath.isCallExpression()) return null;
  const node = callPath.node;
  const callee = node.callee;
  if (!t.isMemberExpression(callee)) return null;
  if (node.arguments.length < 1) return null;

  let named;
  if (!callee.computed) {
    named = t.isIdentifier(callee.property, { name: 'constructor' });
  } else if (t.isStringLiteral(callee.property)) {
    named = callee.property.value === 'constructor';
  } else {
    named = resolveString(callPath.get('callee').get('property')) === 'constructor';
  }
  if (!named) return null;

  return callPath.get('arguments')[0];
}

// ---------------------------------------------------------------------------
// 値の解決（読むだけ。書き戻さない）
// ---------------------------------------------------------------------------

/**
 * 難読化されたコードの中の「定数として決まる値」を求める小さな評価器を作る。
 *
 * 相手にするのは 3 つ:
 *   - string-obfuscation のデコーダ呼び出し   _0x41d94d(0x118)
 *   - control-flow-flattening の辞書参照      _0x3f2479['pNevn']
 *   - 辞書に入った連結・比較関数の呼び出し     _0x3f2479['kYgwU']('debu', _0x3f2479['pNevn'])
 *
 * 求めた値は判定にしか使わない。コードは 1 バイトも書き換えない。
 *
 * @returns {{evaluate: (path) => {ok: boolean, value?: *}, hasDecoder: boolean}}
 */
function buildEvaluator(ast, programScope, timeoutMs) {
  // --- string-obfuscation のデコーダを借りる（無ければ無しで続行）---
  let arrayFn = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (arrayFn) return;
      const m = destring.matchStringArrayFunction(p.node);
      if (m) arrayFn = { ...m, path: p };
    }
  });

  let decode = null;
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
      let rotatorPath = null;
      traverse(ast, {
        ExpressionStatement(p) {
          if (rotatorPath) return;
          if (destring.matchRotatorStatement(p.node, arrayFn.name)) rotatorPath = p;
        }
      });

      const decoderBinding = programScope.getBinding(decoderFn.name);
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
            rotatorPath ? rotatorPath.node : null,
            decoderFn.name,
            timeoutMs
          );
        } catch (_) {
          // デコーダを組み立てられない設定（base64/rc4 + calls transform など）。
          // 文字列を読めないだけなので、読めるものだけを扱って続行する。
          decode = null;
        }
      }
    }
  }

  const FAIL = { ok: false };
  const MAX_DEPTH = 24;

  /** Identifier が「再代入されない、オブジェクトリテラル初期化の束縛」なら、その ObjectExpression を返す。 */
  function dictionaryOf(idPath) {
    if (!t.isIdentifier(idPath.node)) return null;
    const binding = idPath.scope.getBinding(idPath.node.name);
    if (!binding || !binding.constant) return null;
    if (!binding.path.isVariableDeclarator()) return null;
    const init = binding.path.node.init;
    if (!t.isObjectExpression(init)) return null;
    return binding.path.get('init');
  }

  /** 辞書 obj からキー key のプロパティ値 path を取り出す。 */
  function dictionaryProperty(dictPath, key) {
    const props = dictPath.get('properties');
    for (const prop of props) {
      if (!prop.isObjectProperty()) continue;
      const k = prop.node.key;
      const name = t.isIdentifier(k) && !prop.node.computed ? k.name : t.isStringLiteral(k) ? k.value : null;
      if (name === key) return prop.get('value');
    }
    return null;
  }

  /**
   * 式を評価する。env は仮引数名 -> 値（辞書に入った関数を畳むときに使う）。
   */
  function evaluate(nodePath, env = new Map(), depth = 0) {
    if (!nodePath || !nodePath.node || depth > MAX_DEPTH) return FAIL;
    const node = nodePath.node;

    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) {
      return { ok: true, value: node.value };
    }

    if (t.isIdentifier(node)) {
      if (env.has(node.name)) return { ok: true, value: env.get(node.name) };
      const binding = nodePath.scope.getBinding(node.name);
      if (!binding || !binding.constant || !binding.path.isVariableDeclarator()) return FAIL;
      const init = binding.path.node.init;
      if (!init) return FAIL;
      // オブジェクト/関数そのものは値として扱わない（プロパティ参照側で処理する）
      if (t.isObjectExpression(init) || t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
        return FAIL;
      }
      return evaluate(binding.path.get('init'), new Map(), depth + 1);
    }

    if (t.isUnaryExpression(node)) {
      const v = evaluate(nodePath.get('argument'), env, depth + 1);
      if (!v.ok) return FAIL;
      if (node.operator === '!') return { ok: true, value: !v.value };
      if (node.operator === '-') return { ok: true, value: -v.value };
      if (node.operator === 'typeof') return FAIL; // 実行時の型に依存する
      return FAIL;
    }

    if (t.isBinaryExpression(node)) {
      const l = evaluate(nodePath.get('left'), env, depth + 1);
      if (!l.ok) return FAIL;
      const r = evaluate(nodePath.get('right'), env, depth + 1);
      if (!r.ok) return FAIL;
      switch (node.operator) {
        case '+': return { ok: true, value: l.value + r.value };
        case '-': return { ok: true, value: l.value - r.value };
        case '===': return { ok: true, value: l.value === r.value };
        case '==': return { ok: true, value: l.value == r.value }; // eslint-disable-line eqeqeq
        case '!==': return { ok: true, value: l.value !== r.value };
        case '!=': return { ok: true, value: l.value != r.value }; // eslint-disable-line eqeqeq
        case '<': return { ok: true, value: l.value < r.value };
        case '>': return { ok: true, value: l.value > r.value };
        case '<=': return { ok: true, value: l.value <= r.value };
        case '>=': return { ok: true, value: l.value >= r.value };
        default: return FAIL;
      }
    }

    if (t.isLogicalExpression(node)) {
      const l = evaluate(nodePath.get('left'), env, depth + 1);
      if (!l.ok) return FAIL;
      if (node.operator === '&&' && !l.value) return { ok: true, value: l.value };
      if (node.operator === '||' && l.value) return { ok: true, value: l.value };
      return evaluate(nodePath.get('right'), env, depth + 1);
    }

    // 辞書参照 DICT['KEY']
    if (t.isMemberExpression(node) && node.computed) {
      const dict = dictionaryOf(nodePath.get('object'));
      if (!dict) return FAIL;
      const key = evaluate(nodePath.get('property'), env, depth + 1);
      if (!key.ok || typeof key.value !== 'string') return FAIL;
      const valuePath = dictionaryProperty(dict, key.value);
      if (!valuePath) return FAIL;
      return evaluate(valuePath, new Map(), depth + 1);
    }

    if (t.isCallExpression(node)) {
      // デコーダ呼び出し D(0x118)
      if (decode && t.isIdentifier(node.callee)) {
        const binding = nodePath.scope.getBinding(node.callee.name);
        if (binding && aliasBindings.has(binding)) {
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
        return FAIL;
      }

      // 辞書に入った関数の呼び出し DICT['KEY'](a, b) — return <式>; だけを畳む
      if (t.isMemberExpression(node.callee) && node.callee.computed) {
        const dict = dictionaryOf(nodePath.get('callee').get('object'));
        if (!dict) return FAIL;
        const key = evaluate(nodePath.get('callee').get('property'), env, depth + 1);
        if (!key.ok || typeof key.value !== 'string') return FAIL;
        const fnPath = dictionaryProperty(dict, key.value);
        if (!fnPath || !(fnPath.isFunctionExpression() || fnPath.isArrowFunctionExpression())) return FAIL;

        // control-flow-flattening は小さな関数の先頭にデコーダ別名の宣言を挟む:
        //   function(a, b){ const _0x3ec3f7 = _0x2ec7; return _0x16b0f8[_0x3ec3f7(0xf0)](a, b); }
        // 宣言が何個並んでいても、最後が return 1 本なら畳める。
        const body = fnPath.node.body;
        if (!t.isBlockStatement(body) || body.body.length === 0) return FAIL;
        const last = body.body[body.body.length - 1];
        if (!t.isReturnStatement(last) || !last.argument) return FAIL;
        if (!body.body.slice(0, -1).every((st) => t.isVariableDeclaration(st))) return FAIL;

        const params = fnPath.node.params;
        if (!params.every((prm) => t.isIdentifier(prm))) return FAIL;

        const inner = new Map();
        for (let i = 0; i < params.length; i++) {
          const a = evaluate(nodePath.get('arguments')[i], env, depth + 1);
          if (!a.ok) return FAIL;
          inner.set(params[i].name, a.value);
        }
        const stmts = fnPath.get('body').get('body');
        return evaluate(stmts[stmts.length - 1].get('argument'), inner, depth + 1);
      }

      return FAIL;
    }

    return FAIL;
  }

  /** 文字列としてだけ欲しいときの薄い包み。 */
  const resolveString = (nodePath) => {
    const v = evaluate(nodePath);
    return v.ok && typeof v.value === 'string' ? v.value : null;
  };

  return { evaluate, resolveString, hasDecoder: Boolean(decode), hasStringArray: Boolean(arrayFn) };
}

// ---------------------------------------------------------------------------
// 部品の検出
// ---------------------------------------------------------------------------

/**
 * 「DPF の構造をしているが、中に読めない文字列がある」関数を見つける。
 *
 * 文字列を復号できない設定（stringArrayCallsTransform / base64 / rc4 など）で
 * 「debug-protection は無い」と誤って言い切らないための安全弁。
 *
 * 読めない文字列の目印として「プロパティが解決できない計算メンバ呼び出し」
 * (X[_0x4f2a(0x1)](..)) があることを要求する。素の JavaScript に偶然
 * 似た形の関数があっても（自己再帰する内側関数 + 空 catch）ここで落ちる。
 */
function matchDebugProtectionShape(fnPath, resolveString) {
  const node = fnPath.node;
  if (!t.isFunctionDeclaration(node) || !node.id) return false;

  const inners = node.body.body.filter((stmt) => t.isFunctionDeclaration(stmt) && stmt.id);
  if (inners.length !== 1) return false;
  const inner = inners[0];
  const innerName = inner.id.name;

  let selfReferenced = false;
  walk(inner.body, (n) => {
    if (t.isIdentifier(n, { name: innerName })) selfReferenced = true;
  });
  if (!selfReferenced) return false;

  // catch のブロックが空（catch(y){}）— DP テンプレートの目印
  let emptyCatch = false;
  for (const stmt of node.body.body) {
    if (!t.isTryStatement(stmt) || !stmt.handler) continue;
    if (stmt.handler.body.body.length === 0) emptyCatch = true;
  }
  if (!emptyCatch) return false;

  // 読めない文字列があるか
  let unresolved = false;
  fnPath.traverse({
    CallExpression(p) {
      if (unresolved) return;
      const callee = p.node.callee;
      if (!t.isMemberExpression(callee) || !callee.computed) return;
      if (t.isStringLiteral(callee.property)) return;
      if (resolveString(p.get('callee').get('property')) === null) unresolved = true;
    }
  });
  return unresolved;
}

/**
 * debug-protection の本体（DPF）か判定する。
 *
 *   function DPF(ret){
 *     function debuggerProtection(counter){
 *       .. ['constructor']('debu'+'gger')['call']('action') ..
 *       debuggerProtection(++counter);
 *     }
 *     try { if (ret) return debuggerProtection; else debuggerProtection(0x0); } catch(y){}
 *   }
 *
 * 次の 3 点だけを要求する。control-flow-flattening が if/else を辞書経由や
 * 三項に潰していても、deadcode-injection が分岐を足していても壊れない:
 *   (a) 直下に自己再帰する関数宣言がちょうど 1 つある
 *   (b) その内側関数を try ブロックの中から参照している
 *   (c) 内側関数のどこかに X['constructor'](A) があり、A が 'debugger' か
 *       'while (true) {}' に評価できる  ← 決定打
 */
function matchDebugProtectionFunction(fnPath, resolveString) {
  const node = fnPath.node;
  if (!t.isFunctionDeclaration(node) || !node.id) return null;

  // (a) 直下の自己再帰する関数宣言
  const inners = node.body.body.filter((stmt) => t.isFunctionDeclaration(stmt) && stmt.id);
  if (inners.length !== 1) return null;
  const inner = inners[0];
  const innerName = inner.id.name;

  // control-flow-flattening は再帰呼び出しを辞書経由 (_0x3f2479['rcieZ'](inner, ++c)) に
  // 変えてしまうので、「直接呼び出し」ではなく「自分の本体の中に自分の名前が出る」で見る。
  let selfReferenced = false;
  walk(inner.body, (n) => {
    if (t.isIdentifier(n, { name: innerName })) selfReferenced = true;
  });
  if (!selfReferenced) return null;

  // (b) try の中から内側関数を参照している
  let referencedInTry = false;
  for (const stmt of node.body.body) {
    if (!t.isTryStatement(stmt)) continue;
    walk(stmt.block, (n) => {
      if (t.isIdentifier(n, { name: innerName })) referencedInTry = true;
    });
  }
  if (!referencedInTry) return null;

  // (c) X['constructor'](A) の A が debugger 生成の本体
  const bodies = [];
  fnPath.traverse({
    CallExpression(p) {
      const argPath = constructorCallArgument(p, resolveString);
      if (!argPath) return;
      const v = resolveString(argPath);
      if (v !== null && DEBUGGER_BODIES.has(v)) bodies.push(v);
    }
  });
  if (bodies.length === 0) return null;

  return { name: node.id.name, innerName, debuggerBodies: [...new Set(bodies)] };
}

/**
 * calls-controller の宣言か判定する。
 *   var C = (function(){ var firstCall = !![]; return function(ctx, fn){ .. }; }());
 * 「引数なし IIFE で、2 引数の関数式を返す」だけを要求する。
 * control-flow-flattening が中の真偽値を辞書に追い出したり、return を if の中に
 * 押し込んだりしても壊れないよう、フラグの形は条件にせず、return は本体全体から探す
 * （呼ばれ方の側で十分に絞り込めている）。
 */
function matchCallsController(declaratorNode) {
  const init = declaratorNode.init;
  if (!t.isCallExpression(init) || init.arguments.length !== 0) return false;

  const fn = init.callee;
  if (!t.isFunctionExpression(fn) && !t.isArrowFunctionExpression(fn)) return false;
  if (!t.isBlockStatement(fn.body)) return false;

  let found = false;
  walkOwnScope(fn.body, (n) => {
    if (!t.isReturnStatement(n)) return;
    const r = n.argument;
    if ((t.isFunctionExpression(r) || t.isArrowFunctionExpression(r)) && r.params.length === 2) {
      found = true;
    }
  });
  return found;
}

/**
 * 起動部の形をしているか。
 * 難読化器が生成するのは次のどちらかで、どちらも「式文」:
 *   (function(){ C(this, function(){ .. })(); }());   … 引数なし IIFE
 *   setInterval(function(){ DPF(); }, 4000);           … interval > 0 のとき
 * 外側スコープの変数への代入を含むものは、ユーザコードとみなして受け付けない。
 */
function isBootstrapShape(stmtPath, evaluate) {
  if (!stmtPath.isExpressionStatement()) return false;

  const exprPath = stmtPath.get('expression');
  const expr = exprPath.node;
  if (!t.isCallExpression(expr)) return false;

  // (1) 素の IIFE:  (function(){ .. }())
  const isIife =
    (t.isFunctionExpression(expr.callee) || t.isArrowFunctionExpression(expr.callee)) &&
    expr.arguments.length === 0;

  // (2) タイマ:  setInterval(function(){ .. }, 4000)
  const isTimer =
    t.isIdentifier(expr.callee) && ['setInterval', 'setTimeout'].includes(expr.callee.name);

  // (3) control-flow-flattening が IIFE を辞書経由に変えた形:
  //     _0x52101a['wPgpA'](function(){ .. })   ※ 'wPgpA': function(f){ return f(); }
  let isWrappedIife = false;
  if (t.isMemberExpression(expr.callee) && expr.callee.computed) {
    const hasFnArg = expr.arguments.some(
      (a) => t.isFunctionExpression(a) || t.isArrowFunctionExpression(a)
    );
    if (hasFnArg) {
      // 辞書のプロパティとして解決できることまでは求めない（辞書が入れ子のこともある）。
      // 引数に関数式を渡す呼び出しである点と、下の副作用チェックで十分に絞れる。
      isWrappedIife = true;
    }
  }

  if (!isIife && !isTimer && !isWrappedIife) return false;

  // 外の世界を書き換える文はユーザコードとみなして受け付けない。
  // ただし deadcode-injection が入れた死んだ枝は、実行されないので数えない
  // （死んだコピーは束縛の無い識別子を平気で参照する）。
  let hasOuterEffect = false;
  const inside = new Set([stmtPath.node]);

  const outerWrite = (p, target) => {
    if (hasOuterEffect) return;
    if (isUnreachable(p, evaluate)) return; // 死んだ枝
    if (!t.isIdentifier(target)) {
      hasOuterEffect = true; // obj[k] = v — 外への副作用とみなす
      return;
    }
    const binding = p.scope.getBinding(target.name);
    if (!binding || !isInsideAny(binding.path, inside)) hasOuterEffect = true;
  };

  stmtPath.traverse({
    AssignmentExpression(p) {
      outerWrite(p, p.node.left);
    },
    UpdateExpression(p) {
      outerWrite(p, p.node.argument);
    }
  });

  return !hasOuterEffect;
}

// ---------------------------------------------------------------------------
// 到達可能性（deadcode-injection の死んだ枝を見分ける）
// ---------------------------------------------------------------------------

/**
 * この path が「定数比較で偽になる枝」の中にいるか。
 * deadcode-injection の典型形 if ('AAA' === 'BBB') { .. } else { .. } を判定する。
 * 判定できないものは「到達可能」に倒す（安全側）。
 */
function isUnreachable(nodePath, evaluate) {
  let cur = nodePath;
  while (cur && cur.parentPath) {
    const parent = cur.parentPath;
    if (parent.isIfStatement() || parent.isConditionalExpression()) {
      const verdict = evaluate(parent.get('test'));
      if (verdict.ok && typeof verdict.value === 'boolean') {
        const consequent = parent.get('consequent');
        const alternate = parent.get('alternate');
        if (consequent && consequent.node === cur.node && verdict.value === false) return true;
        if (alternate && alternate.node === cur.node && verdict.value === true) return true;
      }
    }
    cur = parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * コードから debug-protection の層だけを剥がす。
 * @returns {{code: string, stats: object, changed: boolean}}
 */
function stripDebugProtection(code, options = {}) {
  const timeoutMs = options.timeout || 5000;

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

  // --- 1. 値の解決器（読むだけ）-------------------------------------------
  const { evaluate, resolveString, hasDecoder, hasStringArray } = buildEvaluator(
    ast,
    programPath.scope,
    timeoutMs
  );

  // --- 2. 本体 DPF を探す --------------------------------------------------
  const candidates = [];
  let structuralOnly = 0;
  traverse(ast, {
    FunctionDeclaration(p) {
      const m = matchDebugProtectionFunction(p, resolveString);
      if (m) candidates.push({ ...m, path: p });
      else if (matchDebugProtectionShape(p, resolveString)) structuralOnly += 1;
    }
  });

  if (candidates.length === 0) {
    // ★ 最悪の偽陰性を塞ぐ。
    // 「文字列配列はあるのにデコーダを組み立てられない」設定では文字列が読めないので、
    // 構造だけ当たった候補があるなら「debug-protection は無い」と言い切ってはいけない。
    if (structuralOnly > 0) {
      throw new StripError(
        `debug-protection の形をした関数が ${structuralOnly} 個あるが、` +
          `中の文字列を復号できないので裏が取れない` +
          `（文字列配列 ${hasStringArray ? 'あり' : 'なし'} / デコーダ ${hasDecoder ? 'あり' : 'なし'}。` +
          'stringArrayCallsTransform や base64/rc4 など未対応の設定）。何も出力しない'
      );
    }
    return {
      code,
      changed: false,
      stats: { reason: 'no-debug-protection', stringsResolvedByDecoder: hasDecoder, structuralOnly }
    };
  }
  if (candidates.length > 1) {
    throw new StripError(
      `debug-protection の本体候補が ${candidates.length} 個見つかった ` +
        `(${candidates.map((c) => c.name).join(', ')})。想定外の形なので何も出力しない`
    );
  }

  const dpf = candidates[0];
  const dpfStmt = listStatement(dpf.path);
  if (!dpfStmt) {
    throw new StripError(`debug-protection の本体 ${dpf.name} を文として取り出せない。想定外の形`);
  }

  // --- 3. 起動部を参照から辿る --------------------------------------------
  // 難読化器は起動部をユーザ関数の本体に注入することがあるので、トップレベルに限らない。
  const dpfBinding = dpf.path.scope.parent
    ? dpf.path.scope.parent.getBinding(dpf.name)
    : programPath.scope.getBinding(dpf.name);
  if (!dpfBinding) {
    throw new StripError(`debug-protection の本体 ${dpf.name} の束縛を解決できない`);
  }

  const bootstrapStmts = new Map(); // node -> path
  let deadReferences = 0;

  for (const ref of dpfBinding.referencePaths) {
    // 死んだ枝からの参照（deadcode-injection のコピー）は触らない
    if (isUnreachable(ref, evaluate)) {
      deadReferences += 1;
      continue;
    }
    // 起動 IIFE の中にも文があるので、外側へたどって「起動部の形をした一番外側の文」を採る。
    const chain = listStatements(ref).filter((p) => p.node !== dpfStmt.node);
    if (chain.length === 0) continue;
    // 消しすぎない側に倒し、起動部の形をした「一番内側」の文を採る。
    // 採り方を誤って剥がし残しが出たときは、後段の参照チェックが必ず捕まえる。
    const shaped = chain.filter((p) => isBootstrapShape(p, evaluate));
    const picked = shaped.length > 0 ? shaped[0] : chain[chain.length - 1];
    bootstrapStmts.set(picked.node, picked);
  }

  if (bootstrapStmts.size === 0) {
    throw new StripError(
      `debug-protection の本体 ${dpf.name} を呼び出している文が見つからない。想定外の形`
    );
  }

  // 安全弁: 起動部の形をしていない文が混ざっていたら、ユーザコードを巻き込む恐れがある
  for (const p of bootstrapStmts.values()) {
    if (!isBootstrapShape(p, evaluate)) {
      throw new StripError(
        `${dpf.name} を参照する文が起動部の形をしていない (${p.node.type})。` +
          'ユーザコードを巻き込む恐れがあるので何も出力しない'
      );
    }
  }

  // --- 4. calls-controller（専用なら削除、共有なら残す）--------------------
  const bootstrapNodes = new Set([...bootstrapStmts.keys()]);
  const controllerBindings = new Set();

  for (const p of bootstrapStmts.values()) {
    p.traverse({
      Identifier(ip) {
        if (!ip.isReferencedIdentifier()) return;
        const binding = ip.scope.getBinding(ip.node.name);
        if (!binding || !binding.path.isVariableDeclarator()) return;
        // 起動部の内側で宣言された変数は controller ではない
        if (isInsideAny(binding.path, bootstrapNodes)) return;
        if (!matchCallsController(binding.path.node)) return;
        controllerBindings.add(binding);
      }
    });
  }

  if (controllerBindings.size > 1) {
    throw new StripError('起動部から calls-controller の候補が複数見つかった。想定外の形');
  }

  let controllerName = null;
  let controllerShared = false;
  let controllerStmt = null;

  if (controllerBindings.size === 1) {
    const binding = [...controllerBindings][0];
    controllerName = binding.identifier.name;

    // 参照が起動部の中だけかを数える。self-defending と共有されていれば削除しない。
    const outside = binding.referencePaths.filter((ref) => {
      if (isInsideAny(ref, bootstrapNodes)) return false;
      return !isUnreachable(ref, evaluate);
    });

    if (outside.length > 0) {
      controllerShared = true;
    } else {
      const declPath = binding.path; // VariableDeclarator
      const declStmt = declPath.parentPath;
      // 宣言子が 1 個だけの宣言文なら文ごと、複数あるなら宣言子だけを消す
      controllerStmt =
        t.isVariableDeclaration(declStmt.node) && declStmt.node.declarations.length === 1
          ? declStmt
          : declPath;
    }
  }

  // --- 5. 削除の準備と残留スキャン -----------------------------------------
  const removalPaths = [dpfStmt, ...bootstrapStmts.values()];
  if (controllerStmt) removalPaths.push(controllerStmt);

  const removalNodes = new Set(removalPaths.map((p) => p.node));
  const removedNames = [dpf.name];
  if (controllerStmt) removedNames.push(controllerName);

  // 削除しても残る debugger 生成を分類する。
  // 到達不能（deadcode-injection のコピー）なら残してよい。到達可能なら失敗。
  const deadFragments = [];
  const liveFragments = [];
  traverse(ast, {
    CallExpression(p) {
      const argPath = constructorCallArgument(p, resolveString);
      if (!argPath) return;
      if (isInsideAny(p, removalNodes)) return;
      const v = resolveString(argPath);
      if (v === null || !DEBUGGER_BODIES.has(v)) return;
      const loc = p.node.loc ? `${p.node.loc.start.line}:${p.node.loc.start.column}` : '?';
      (isUnreachable(p, evaluate) ? deadFragments : liveFragments).push(`${v}@${loc}`);
    }
  });

  if (liveFragments.length > 0) {
    throw new StripError(
      `到達可能な debugger 生成が ${liveFragments.length} 箇所残る ` +
        `(${liveFragments.slice(0, 3).join(', ')})。解除しきれていないので何も出力しない`
    );
  }

  const removedBytes = removalPaths.reduce(
    (sum, p) => sum + generate(p.node, { compact: true }).code.length,
    0
  );
  // 「難読化後 − 除去分 = 解除後」の等式を検証側が立てられるように、
  // 除去するノードの種別ヒストグラムを削除前に取っておく（削除後は node が null になる）。
  const removedTypeCounts = typeHistogram(removalPaths.map((p) => p.node));

  // --- 6. 削除 -------------------------------------------------------------
  for (const p of removalPaths) p.remove();

  // --- 7. 検算: 削除した名前への到達可能な参照が残っていないか ---------------
  programPath.scope.crawl();
  const dangling = [];
  let danglingInDeadCode = 0;
  traverse(ast, {
    Identifier(p) {
      if (!removedNames.includes(p.node.name)) return;
      if (!p.isReferencedIdentifier()) return;
      if (p.scope.getBinding(p.node.name)) return; // 別スコープの同名変数
      if (isUnreachable(p, evaluate)) {
        danglingInDeadCode += 1;
        return;
      }
      dangling.push(p.node.name);
    }
  });
  if (dangling.length > 0) {
    throw new StripError(
      `削除した ${[...new Set(dangling)].join(', ')} への到達可能な参照が ${dangling.length} 箇所残っている`
    );
  }

  // --- 8. 出力（入力が 1 行なら 1 行のまま）--------------------------------
  const inputCompact = !code.trim().includes('\n');
  const out = generate(ast, {
    compact: inputCompact,
    retainLines: false,
    comments: true
  }).code;

  try {
    parser.parse(out, PARSER_OPTIONS);
  } catch (err) {
    throw new StripError(`出力がパースできない: ${err.message}`);
  }

  return {
    code: out,
    changed: true,
    stats: {
      debugProtectionFunction: dpf.name,
      innerFunction: dpf.innerName,
      debuggerBodies: dpf.debuggerBodies,
      bootstrapStatements: bootstrapStmts.size,
      controller: controllerName,
      controllerShared,
      stringsResolvedByDecoder: hasDecoder,
      deadFragments: deadFragments.length,
      deadReferences,
      danglingInDeadCode,
      removedBytes,
      removedTypeCounts
    }
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `使い方:
  node strip-debug-protection.js <input.js> [-o <output.js>] [--stats]
  node strip-debug-protection.js --batch <indir> -o <outdir> [options]

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
  const result = stripDebugProtection(code, { timeout: opts.timeout });

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
  stripDebugProtection,
  StripError,
  DEBUGGER_BODIES,
  // 検証・診断用に内部も出す（verify.js と、形が変わったときの調査で使う）
  buildEvaluator,
  matchDebugProtectionFunction,
  matchDebugProtectionShape,
  listStatement,
  isUnreachable
};

if (require.main === module) {
  main();
}
