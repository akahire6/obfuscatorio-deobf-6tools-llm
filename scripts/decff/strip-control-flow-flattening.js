#!/usr/bin/env node
'use strict';

/**
 * strip-control-flow-flattening.js
 *
 * javascript-obfuscator (obfuscator.io) が掛けた難読化のうち、
 * **control-flow-flattening の層だけ**を決定論的に剥がす。
 * 姉妹スクリプト ../destring/strip-string-obfuscation.js の CFF 版で、
 * ../../deobfuscate.js が掛ける 6 段のうち 3 段目。
 *
 * ★ controlFlowFlattening は 2 種類のコードを生む。両方を剥がす。
 *
 *   (a) control flow storage 辞書（多数派。実データの全問に出る）
 *       var S = {'ENUXx':function(a,b){return a(b);},      // 呼び出しの間接化
 *                'MHoSl':function(a,b){return a+b;},        // 二項演算の間接化
 *                'DySfa':'RNVKk',                           // 文字列定数の間接化
 *                'MjWLl':OTHER['LcEku']};                   // 別辞書への委譲
 *       S['MHoSl'](x, y)   ->   x + y
 *
 *   (b) switch ディスパッチャ（C77-0 では 140/1301 = 10.8%）
 *       var ORD = S['wJRmM']['split']('|');   // 順序文字列は storage の中にいる
 *       var IDX = 0;
 *       while (!![]) { switch (ORD[IDX++]) { case '0': A; continue; ... } break; }
 *          ->   元の文順に戻して親ブロックへ直接展開
 *
 * ★ (a) を先に畳まないと (b) の順序文字列が読めない。処理順序は storage -> switch。
 *
 * 触らないもの（= 残り 6 変換はそのまま残る）:
 *   string-obfuscation の文字列配列・デコーダ・ローテータ（1 バイトも変えない。
 *   storage のキーだった要素が到達不能な余りになるのが正しい。抜くと検査和が壊れる）/
 *   deadcode-injection のダミー分岐（S['CGmEW']('wwyYH',S['QzoDA']) を畳むと
 *   'wwyYH'==='wwyYH' になるが、定数畳み込みはしないので if 自体は残る）/
 *   debug-protection / self-defending / name-obfuscation の 16 進識別子 / code-compact。
 *
 * ★ 出力は 1 行 compact のまま。整形して出してはいけない。
 *   (a) code-compact まで解除したことになる。
 *   (b) self-defending は fn.toString().search('(((.+)+)+)+$') で整形を検出する。
 *       改行が入ると catastrophic backtracking で事実上ハングする。
 *       CFF は self-defending の内側も書き換えるので、この保護はいっそう重要。
 *
 * ★ 文字列は「読む」が「書き戻さない」。
 *   生の 7 変換入力では storage のキー参照が S[dec(0x1b8)] の形になる（実測で
 *   2778 件中 2080 件）。検出のために ../destring の部品を借りてデコーダを vm 上に
 *   組み立て、キーを読む。復号した文字列は出力に一切出さない。
 *
 * ★ Babel の落とし穴。scope.crawl() は Binding オブジェクトを作り直すので、
 *   Set<Binding> を crawl を跨いで持ち回ると判定が全部 false になる。
 *   識別は必ず binding.path.node（宣言ノード）の同一性で行う。
 *   また traverse 中の replaceWith は内側の path を detach するので、
 *   「仕事を集めてから深さ降順に適用」する。
 *
 * ★ 安全弁: 少しでも確信が持てない状況では畳まない。壊れるより残す方を選ぶ。
 *   致命的な状況（残骸・生成失敗・整形の混入）では出力せず非ゼロ終了する。
 */

const fs = require('fs');
const path = require('path');

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const destring = require('../destring/strip-string-obfuscation.js');

// ★ StripError は destring が export した「そのオブジェクト」を使う。
//   ここで新しい class を定義すると instanceof が両側で成立しなくなる。
const StripError = destring.StripError;

const PARSER_OPTIONS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  errorRecovery: false
};

/** storage のキーが取りうる形。obfuscator.io は 5 文字の英字を使う（実測 2429/2429）。 */
const STORAGE_KEY_RE = /^[A-Za-z]{5}$/;

const MAX_OUTER_ROUNDS = 8;
const MAX_FOLD_PASSES = 32;
const MAX_REMOVE_PASSES = 16;
const MAX_UNFLATTEN_PASSES = 64;
const MAX_DELEGATION_DEPTH = 16;
const MAX_REPARSE_ROUNDS = 8;

// ---------------------------------------------------------------------------
// 小道具（★ ../destring の traverse / scope 機構は借りない。Babel のコピーが
//          別なので、AST を跨がせるのは .type ベースの純粋な述語だけにする）
// ---------------------------------------------------------------------------

/** 部分木のノード種別ヒストグラムを取る。検証で「何を消し何を足したか」を照合するため。 */
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

/** 祖先をたどって、いずれかのノードの内側にいるかを見る。 */
function isInsideAny(nodePath, nodes) {
  let cur = nodePath;
  while (cur) {
    if (nodes.has(cur.node)) return true;
    cur = cur.parentPath;
  }
  return false;
}

/** path の深さ（親をたどった回数）。深い方から置換するために使う。 */
function depthOf(nodePath) {
  let d = 0;
  let cur = nodePath;
  while (cur) {
    d += 1;
    cur = cur.parentPath;
  }
  return d;
}

/** ヒストグラムを足し込む。 */
function addCounts(into, counts) {
  for (const k of Object.keys(counts)) into[k] = (into[k] || 0) + counts[k];
}

/** 部分木の全ノードを訪れる（path 不要の単純走査）。 */
function walk(node, cb) {
  if (!node || typeof node.type !== 'string') return;
  cb(node);
  for (const key of t.VISITOR_KEYS[node.type] || []) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => walk(c, cb));
    else if (child && typeof child.type === 'string') walk(child, cb);
  }
}

/**
 * path キャッシュとスコープを作り直す。
 * ★ replaceWith / remove / splice を繰り返すと traverse の NodePath キャッシュが
 *   古いままになり、次の走査で「あるはずのノードが見えない」「scope.getBinding が
 *   古い束縛を返す」が起きる。構造を変えたら必ずここを通す。
 *   別名や storage の識別はノードの同一性で持っているので、キャッシュを捨てても壊れない。
 */
function refreshScope(ast) {
  traverse.cache.clear();
  let scope = null;
  traverse(ast, {
    Program(p) {
      scope = p.scope;
      p.stop();
    }
  });
  if (scope) scope.crawl();
  return scope;
}

// ---------------------------------------------------------------------------
// Phase A — 文字列層コンテキスト（読むだけ。AST は 1 ノードも変えない）
// ---------------------------------------------------------------------------

/**
 * 文字列配列関数・デコーダ・ローテータを見つけ、vm 上に実物のデコーダを組み立てる。
 * ラッパー別名は「宣言ノードの同一性」の Set で持つ（★ Binding で持ってはいけない）。
 *
 * @returns {null | {decode, aliasDeclNodes:Set, partNodes:Set, arrayStrings:string[], names:object}}
 */
function buildStringLayerContext(ast, programScope, timeoutMs) {
  let arrayFn = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (arrayFn) return;
      const m = destring.matchStringArrayFunction(p.node);
      if (m) arrayFn = { ...m, path: p };
    }
  });

  // 文字列層が無い入力（cff-only 構成や生ソース）。キーは素のリテラルだけを読む。
  if (!arrayFn) return null;

  let decoderFn = null;
  traverse(ast, {
    FunctionDeclaration(p) {
      if (decoderFn) return;
      const m = destring.matchDecoderFunction(p.node, arrayFn.name);
      if (m) decoderFn = { ...m, path: p };
    }
  });

  if (!decoderFn) {
    throw new StripError(
      `文字列配列関数 ${arrayFn.name} は見つかったがデコーダ関数が見つからない` +
        '（stringArrayCallsTransform など未対応の設定の可能性がある）'
    );
  }

  let rotatorPath = null;
  traverse(ast, {
    ExpressionStatement(p) {
      if (rotatorPath) return;
      if (destring.matchRotatorStatement(p.node, arrayFn.name)) rotatorPath = p;
    }
  });

  const decode = destring.buildDecoder(
    arrayFn.path.node,
    decoderFn.path.node,
    rotatorPath ? rotatorPath.node : null,
    decoderFn.name,
    timeoutMs
  );

  const decoderBinding = programScope.getBinding(decoderFn.name);
  if (!decoderBinding) throw new StripError(`デコーダ ${decoderFn.name} の束縛を解決できない`);

  // ★ 別名は宣言ノードの同一性で持つ。crawl() を跨いでも壊れない。
  const aliasDeclNodes = new Set([decoderBinding.path.node]);
  for (let pass = 0; pass < 16; pass++) {
    let added = false;
    traverse(ast, {
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id) || !t.isIdentifier(p.node.init)) return;
        if (aliasDeclNodes.has(p.node)) return;
        const target = p.scope.getBinding(p.node.init.name);
        if (!target || !aliasDeclNodes.has(target.path.node)) return;
        aliasDeclNodes.add(p.node);
        added = true;
      }
    });
    if (!added) break;
  }

  const partNodes = new Set([arrayFn.path.node, decoderFn.path.node]);
  if (rotatorPath) partNodes.add(rotatorPath.node);

  return {
    decode,
    aliasDeclNodes,
    partNodes,
    arrayStrings: arrayFn.strings,
    names: {
      arrayFunction: arrayFn.name,
      decoderFunction: decoderFn.name,
      rotator: Boolean(rotatorPath),
      aliasCount: aliasDeclNodes.size
    }
  };
}

/**
 * 式から文字列値を読む。読めなければ null。
 *   'abc'            -> 'abc'
 *   dec(0x1ff)       -> 文字列層のデコーダを実際に呼んで得た値
 * ★ これ 1 つで「storage のキーが素のリテラル」「デコーダ呼び出し」の
 *   二重間接を同じ経路で吸収する。
 */
function readStr(node, scope, ctx) {
  if (t.isStringLiteral(node)) return node.value;
  if (!ctx || !t.isCallExpression(node) || !t.isIdentifier(node.callee)) return null;

  const b = scope.getBinding(node.callee.name);
  if (!b || !ctx.aliasDeclNodes.has(b.path.node)) return null;

  const args = [];
  for (const a of node.arguments) {
    const lit = destring.literalArgValue(a);
    if (!lit.ok) return null;
    args.push(lit.value);
  }

  let v;
  try {
    v = ctx.decode.apply(null, args);
  } catch (_) {
    return null;
  }
  return typeof v === 'string' ? v : null;
}

// ---------------------------------------------------------------------------
// 「純デリゲート関数式」の判定
// ---------------------------------------------------------------------------

/**
 * CFF の storage が持つ転送関数か。
 *   function (a, b) { return a + b; }         二項演算
 *   function (a, b) { return a(b); }          呼び出し
 *   function (a, b) { return OTHER['K'](a,b); } 多段委譲
 *
 * ★ 各パラメータが「ちょうど 1 回」「宣言順に」現れることを要求する。
 *   これを満たす限り、実引数をそのまま埋めても評価回数・評価順序が変わらない。
 *   実測では 2429 プロパティすべてが満たしていたが、満たさない形を黙って畳むと
 *   副作用のある実引数が二重評価/評価漏れを起こすので、判定は必ず行う。
 */
function isPureDelegate(fn, ctx) {
  if (!t.isFunctionExpression(fn)) return false;
  if (fn.id || fn.async || fn.generator) return false;
  if (!fn.params.every((p) => t.isIdentifier(p))) return false;
  if (!t.isBlockStatement(fn.body) || fn.body.body.length === 0) return false;

  // ★ stringArrayWrappersChainedCalls が有効だと、転送関数の本体先頭に
  //   復号器別名の再束縛（var _0x48578c = _0x397252;）が挟まる。
  //   これは読み飛ばす。終端まで解決してから展開するので、この別名を
  //   呼び出し側にコピーすることはない。
  const body = fn.body.body;
  for (let i = 0; i < body.length - 1; i++) {
    const st = body[i];
    if (!t.isVariableDeclaration(st)) return false;
    if (!ctx || !st.declarations.every((d) => ctx.aliasDeclNodes.has(d))) return false;
  }

  const st = body[body.length - 1];
  if (!t.isReturnStatement(st) || !st.argument) return false;

  const names = fn.params.map((p) => p.name);

  // return 式に現れるパラメータの順序列が、宣言順と完全一致すること
  const seen = [];
  walk(st.argument, (n) => {
    if (n.type === 'Identifier' && names.includes(n.name)) seen.push(n.name);
  });
  if (seen.length !== names.length) return false;
  for (let i = 0; i < names.length; i++) {
    if (seen[i] !== names[i]) return false;
  }

  const expr = st.argument;

  // (i) p0 OP p1
  if (t.isBinaryExpression(expr) || t.isLogicalExpression(expr)) {
    return names.length === 2 && t.isIdentifier(expr.left) && t.isIdentifier(expr.right);
  }

  // (ii) p0(p1, ..., pn-1) / (iii) OTHER['K'](p0, ..., pn-1)
  if (t.isCallExpression(expr) && !expr.optional) {
    if (expr.arguments.some((a) => !t.isIdentifier(a))) return false;
    if (t.isIdentifier(expr.callee)) {
      // callee が第 0 パラメータ（実測 290/290 がこの形）
      return names.length >= 1 && expr.callee.name === names[0];
    }
    if (t.isMemberExpression(expr.callee) && !expr.callee.optional) {
      // 別辞書への委譲。callee はパラメータを含まない
      return true;
    }
  }

  return false;
}

/** 純デリゲート関数の return 式。 */
function returnExprOf(fn) {
  return fn.body.body[fn.body.body.length - 1].argument;
}

/** 純デリゲート関数の return 式の形。'binary' / 'call-param' / 'call-member' */
function delegateShape(fn) {
  const expr = returnExprOf(fn);
  if (t.isBinaryExpression(expr) || t.isLogicalExpression(expr)) return 'binary';
  if (t.isCallExpression(expr) && t.isIdentifier(expr.callee)) return 'call-param';
  return 'call-member';
}

// ---------------------------------------------------------------------------
// Phase B — storage 辞書の検出
// ---------------------------------------------------------------------------

/**
 * VariableDeclarator が CFF の storage 辞書か判定する。
 * 誤検出（ユーザーコードのオブジェクトを畳む）を避けるため、条件は全部 AND。
 *
 * ★ 「ブロックの先頭にあること」は条件に入れていない。自前コーパスで測ったところ、
 *   位置を見ても見なくても、難読化していない実コード 19 本の判定は同じだった
 *   （どちらも誤検出ゼロ）。一方で、自分が storage を消したりディスパッチャを
 *   展開したりすると後続の文が繰り上がって判定が変わり、畳み残しと
 *   「2 回掛けると結果が変わる」を引き起こす。守れていないものを守るために
 *   壊れるので、入れない。
 *
 * ★ 残る限界: 5 文字キーだけを持ち、全プロパティが転送関数か定数で、定数キーでしか
 *   参照されないオブジェクトは、ユーザーが書いたものでも CFF の storage と構造上
 *   区別できない。そういうオブジェクトは畳まれる（挙動は変わらない）。
 */
function matchStorage(p, ctx, opts) {
  if (!t.isIdentifier(p.node.id) || !t.isObjectExpression(p.node.init)) return null;

  const obj = p.node.init;
  if (obj.properties.length === 0) return null;

  // (2) 文字列層 3 部品の内側は触らない
  if (ctx && isInsideAny(p, ctx.partNodes)) return null;

  // (3)(4) 全プロパティが非 computed の ObjectProperty、キーは 5 文字英字、重複なし
  const keyMap = Object.create(null);
  const keyPaths = Object.create(null);
  const propPaths = p.get('init.properties');
  for (let i = 0; i < obj.properties.length; i++) {
    const pr = obj.properties[i];
    if (!t.isObjectProperty(pr) || pr.computed) return null;
    const key = t.isStringLiteral(pr.key) ? pr.key.value : t.isIdentifier(pr.key) ? pr.key.name : null;
    if (key === null || !STORAGE_KEY_RE.test(key)) return null;
    if (key in keyMap) return null;
    keyMap[key] = pr.value;
    // 値の NodePath も持つ。転送関数の中で復号器別名が再束縛されるので、
    // キーを読むときはその関数自身のスコープが要る。
    keyPaths[key] = propPaths[i] ? propPaths[i].get('value') : null;
  }

  // (5)(6) 値の形。
  //
  // 「CFF が作ったものだ」と言い切れる印を 1 つは要求する。印になるのは
  //   - 転送関数（return a OP b / return a(b) / return OTHER['K'](a,b)）
  //   - 文字列層のデコーダ呼び出し（= 難読化器が入れた文字列）
  // どちらも無く、素のリテラルだけが並ぶオブジェクトはユーザーの
  // データ辞書と区別できないので対象にしない。
  //
  // ★ 転送関数だけを印にしてはいけない。CFF の StringLiteralControlFlowReplacer は
  //   「全プロパティが文字列定数」の storage も作る（関数が 1 つも無い）。
  //   それを取りこぼすと、そこへ委譲している子 storage も芋づるで畳めなくなる。
  let hasSignal = false;
  for (const key of Object.keys(keyMap)) {
    const v = keyMap[key];
    if (isPureDelegate(v, ctx)) {
      hasSignal = true;
      continue;
    }
    if (readStr(v, p.scope, ctx) !== null) {
      // 素のリテラルは印にならない。デコーダ呼び出しだけが印になる。
      if (!t.isStringLiteral(v)) hasSignal = true;
      continue;
    }
    if (t.isStringLiteral(v) || t.isNumericLiteral(v)) continue;
    // 別辞書への委譲 OTHER['K']
    if (t.isMemberExpression(v) && v.computed && t.isIdentifier(v.object)) continue;
    return null;
  }
  if (!hasSignal) return null;

  // (7) 再代入されていない
  const binding = p.scope.getBinding(p.node.id.name);
  if (!binding || !binding.constant) return null;
  if (binding.path.node !== p.node) return null;

  // (8) 全参照が S[<読めるキー>] の object 位置にある
  for (const ref of binding.referencePaths) {
    const pp = ref.parentPath;
    if (!pp || !pp.isMemberExpression() || pp.node.object !== ref.node) return null;
    if (!pp.node.computed) return null;
    if (readStr(pp.node.property, ref.scope, ctx) === null) return null;
  }

  // (9) 位置条件: 囲むブロックの先頭にある（先行文が復号器別名宣言だけなら読み飛ばす）
  //
  // ★ 判定は「最初に見たとき」の結果を宣言ノードごとに記憶して使い回す。
  //   ディスパッチャを展開すると、ケース本体にいた宣言が親ブロックの途中に移る。
  //   毎回その場で判定すると、自分が解除したせいで条件が崩れて畳み残しになる。
  //   ノードは splice で「移動」させるだけなので同一性は保たれる。
  return { declPath: p, name: p.node.id.name, keyMap, keyPaths, node: p.node };
}

/** AST 全体から storage 辞書を集める。キーは宣言ノード。 */
function collectStorages(ast, ctx, opts) {
  const cands = new Map();
  traverse(ast, {
    VariableDeclarator(p) {
      const m = matchStorage(p, ctx, opts);
      if (m) cands.set(p.node, m);
    }
  });
  return cands;
}

/**
 * S[key] の値を、多段委譲をたどって解決する。AST は書き換えない。
 * 委譲先の名前は「宣言側のスコープ」で引く。
 */
function lookupTransitive(scope, objName, key, cands, ctx, depth) {
  if (depth > MAX_DELEGATION_DEPTH) return { error: 'depth' };

  const b = scope.getBinding(objName);
  if (!b || !cands.has(b.path.node)) return null;

  const info = cands.get(b.path.node);
  const v = info.keyMap[key];
  if (v === undefined) return null;

  const vPath = info.keyPaths[key];
  const vScope = vPath && vPath.scope ? vPath.scope : info.declPath.scope;

  if (t.isMemberExpression(v)) {
    if (!v.computed || !t.isIdentifier(v.object)) return null;
    const k2 = readStr(v.property, vScope, ctx);
    if (k2 === null) return null;
    return lookupTransitive(vScope, v.object.name, k2, cands, ctx, depth + 1);
  }

  return { value: v, owner: info, scope: vScope };
}

/**
 * 転送関数が別の辞書へ委譲している（return OTHER['K'](a, b) の形）とき、
 * 終端の転送関数（return a OP b / return a(b)）まで辿る。
 *
 * ★ 委譲の式そのものをコピーしてはいけない。OTHER['K'] のキーは
 *   その関数の中で再束縛された復号器別名で書かれていることがあり、
 *   呼び出し側にコピーすると未定義の名前を参照してしまう。
 *   終端まで辿れば、残るのはパラメータだけの式になる。
 *
 * 各段は「自分のパラメータをそのままの順序で渡す」ことが isPureDelegate で
 * 保証されているので、引数の対応は位置がそのまま保たれる。
 */
function resolveDelegateTerminal(fn, fnScope, cands, ctx, depth) {
  if (depth > MAX_DELEGATION_DEPTH) return { error: 'depth' };
  if (delegateShape(fn) !== 'call-member') return { fn };

  const ret = returnExprOf(fn);
  const callee = ret.callee;
  if (!t.isMemberExpression(callee) || !callee.computed || !t.isIdentifier(callee.object)) return null;

  const key = readStr(callee.property, fnScope, ctx);
  if (key === null) return null;

  const hit = lookupTransitive(fnScope, callee.object.name, key, cands, ctx, 0);
  if (!hit) return null;
  if (hit.error) return { error: hit.error };

  const next = hit.value;
  if (!isPureDelegate(next, ctx)) return null;
  if (next.params.length !== ret.arguments.length) return null;

  return resolveDelegateTerminal(next, hit.scope, cands, ctx, depth + 1);
}

// ---------------------------------------------------------------------------
// Phase C — インライン展開
// ---------------------------------------------------------------------------

/** 転送関数の本体にパラメータを埋めて、置換する式を作る。 */
function substituteParams(fn, args) {
  const map = Object.create(null);
  fn.params.forEach((p, i) => {
    map[p.name] = args[i];
  });

  const expr = t.cloneNode(returnExprOf(fn), true, false);

  const replaceIn = (node) => {
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          const c = child[i];
          if (c && c.type === 'Identifier' && c.name in map) child[i] = t.cloneNode(map[c.name], true, false);
          else if (c && typeof c.type === 'string') replaceIn(c);
        }
      } else if (child && typeof child.type === 'string') {
        if (child.type === 'Identifier' && child.name in map) node[key] = t.cloneNode(map[child.name], true, false);
        else replaceIn(child);
      }
    }
  };
  replaceIn(expr);
  return expr;
}

/** 置換ノードの自由識別子が、移動先でも同じ宣言に解決されるか。 */
function bindingsPreserved(newNode, srcScope, destScope) {
  const names = new Set();
  walk(newNode, (n) => {
    if (n.type === 'Identifier') names.add(n.name);
  });
  for (const name of names) {
    const a = srcScope.getBinding(name);
    const b = destScope.getBinding(name);
    const an = a ? a.path.node : null;
    const bn = b ? b.path.node : null;
    if (an !== bn) return false;
  }
  return true;
}

/**
 * storage 参照を畳む。不動点。
 * ★ traverse 中に replaceWith してはいけない（内側 path が detach されて
 *   ReferenceError: Container is falsy になる）。仕事を集めてから深さ降順に適用する。
 */
function foldStorages(ast, programScope, ctx, ledger, stats, opts) {
  let anyChange = false;

  for (let pass = 0; pass < MAX_FOLD_PASSES; pass++) {
    programScope = refreshScope(ast);
    const cands = collectStorages(ast, ctx, opts);
    stats.storagesFound = Math.max(stats.storagesFound, cands.size);
    if (cands.size === 0) break;

    const declNodes = new Set(cands.keys());
    const jobs = [];

    traverse(ast, {
      MemberExpression(p) {
        if (!p.node.computed || !t.isIdentifier(p.node.object)) return;
        // 辞書リテラルの内側そのものは書き換えない
        if (isInsideAny(p, declNodes)) return;

        const key = readStr(p.node.property, p.scope, ctx);
        if (key === null) return;

        const hit = lookupTransitive(p.scope, p.node.object.name, key, cands, ctx, 0);
        if (hit === null) return;
        if (hit.error === 'depth') {
          throw new StripError(`storage の委譲が深すぎる（${MAX_DELEGATION_DEPTH} 段超）。循環の疑いがある`);
        }

        const val = hit.value;

        if (!isPureDelegate(val, ctx)) {
          // 定数（文字列・数値・デコーダ呼び出し）はそのまま埋める
          if (!bindingsPreserved(val, hit.scope, p.scope)) {
            stats.skipped.bindingNotPreserved += 1;
            return;
          }
          jobs.push({ kind: 'const', path: p, node: val, depth: depthOf(p) });
          return;
        }

        // 転送関数は「呼び出しの callee 位置」でしか展開できない
        const par = p.parentPath;
        if (!par || !par.isCallExpression() || par.node.callee !== p.node) {
          stats.skipped.nonCalleeFnRef += 1;
          return;
        }
        const args = par.node.arguments;
        if (args.length !== val.params.length || args.some((a) => t.isSpreadElement(a))) {
          stats.skipped.arityMismatch += 1;
          return;
        }

        // 多段委譲は終端まで辿る（委譲の式自体はコピーしない）
        const term = resolveDelegateTerminal(val, hit.scope, cands, ctx, 0);
        if (!term) {
          stats.skipped.unresolvedDelegate += 1;
          return;
        }
        if (term.error === 'depth') {
          throw new StripError(`storage の委譲が深すぎる（${MAX_DELEGATION_DEPTH} 段超）。循環の疑いがある`);
        }
        const fn = term.fn;
        if (fn.params.length !== args.length) {
          stats.skipped.arityMismatch += 1;
          return;
        }

        // ★ this バインディングの罠: S['call'](obj.m, x) -> obj.m(x) は this が変わる
        if (delegateShape(fn) === 'call-param' && t.isMemberExpression(args[0])) {
          stats.skipped.thisBindingHazard += 1;
          return;
        }

        jobs.push({ kind: 'call', path: par, fn, depth: depthOf(par) });
      }
    });

    if (jobs.length === 0) break;

    // 深い方から適用する
    jobs.sort((a, b) => b.depth - a.depth);

    let applied = 0;
    for (const j of jobs) {
      if (!j.path.node || j.path.removed || !j.path.container) continue;

      const newNode =
        j.kind === 'const'
          ? t.cloneNode(j.node, true, false)
          : substituteParams(j.fn, j.path.node.arguments);

      ledger.removed(typeHistogram([j.path.node]));
      ledger.added(typeHistogram([newNode]));
      j.path.replaceWith(newNode);
      applied += 1;
      if (j.kind === 'const') stats.constFolds += 1;
      else stats.callFolds += 1;
    }

    if (applied === 0) break;
    anyChange = true;
    stats.passes.fold += 1;
  }

  return anyChange;
}

// ---------------------------------------------------------------------------
// Phase D — 参照が 0 になった storage の除去（不動点・leaf first）
// ---------------------------------------------------------------------------

/**
 * ★ 1 回で済ませてはいけない。子 storage の値 'MjWLl': PARENT['LcEku'] が
 *   親への参照として生き残るので、子を消してから親を消す必要がある。
 */
function removeDeadStorages(ast, programScope, ctx, ledger, stats, opts) {
  let anyChange = false;

  for (let pass = 0; pass < MAX_REMOVE_PASSES; pass++) {
    programScope = refreshScope(ast);
    const cands = collectStorages(ast, ctx, opts);
    if (cands.size === 0) break;

    let removed = 0;
    for (const info of cands.values()) {
      const p = info.declPath;
      if (!p.node || p.removed) continue;

      const b = p.scope.getBinding(info.name);
      if (!b || b.path.node !== p.node) continue;
      if (b.referencePaths.length !== 0) continue;

      // ★ 台帳の付け方に注意。typeHistogram([declarator]) には包んでいる
      //   VariableDeclaration の 1 個が入らない。しかも declarator を remove すると
      //   空になった宣言を Babel が勝手に消すので、後から数えると取りこぼす。
      //   宣言ごと消えるかどうかを先に判断して、消える分を先に計上する。
      const decl = p.parentPath;
      const wholeDecl =
        decl && t.isVariableDeclaration(decl.node) && decl.node.declarations.length === 1;

      ledger.removed(typeHistogram([p.node]));
      if (wholeDecl) {
        ledger.removed({ VariableDeclaration: 1 });
        decl.remove();
      } else {
        p.remove();
      }
      removed += 1;
      stats.storagesRemoved += 1;
    }

    if (removed === 0) break;
    anyChange = true;
    stats.passes.remove += 1;
  }

  return anyChange;
}

// ---------------------------------------------------------------------------
// Phase E — switch ディスパッチャの展開
// ---------------------------------------------------------------------------

/** while (!![]) か。 */
function isAlwaysTrueTest(node) {
  return (
    t.isUnaryExpression(node, { operator: '!' }) &&
    t.isUnaryExpression(node.argument, { operator: '!' }) &&
    t.isArrayExpression(node.argument.argument) &&
    node.argument.argument.elements.length === 0
  );
}

/**
 * ディスパッチャ三つ組を検出する。
 *   var ORD = <順序文字列>['split']('|');
 *   var IDX = 0;
 *   while (!![]) { switch (ORD[IDX++]) { case '0': ...; continue; ... } break; }
 */
function matchDispatcher(whilePath, ctx, stats) {
  const w = whilePath.node;

  // W1 test
  if (!isAlwaysTrueTest(w.test)) return null;

  // W2/W3 本体は [SwitchStatement, ラベル無し BreakStatement]
  if (!t.isBlockStatement(w.body) || w.body.body.length !== 2) return null;
  const sw = w.body.body[0];
  const br = w.body.body[1];
  if (!t.isSwitchStatement(sw) || !t.isBreakStatement(br) || br.label) return null;

  // W4 discriminant は ARR[IDX++]
  const disc = sw.discriminant;
  if (!t.isMemberExpression(disc) || !disc.computed || !t.isIdentifier(disc.object)) return null;
  const upd = disc.property;
  if (!t.isUpdateExpression(upd) || upd.operator !== '++' || upd.prefix || !t.isIdentifier(upd.argument)) return null;
  const arrName = disc.object.name;
  const idxName = upd.argument.name;

  // W5 直前 2 文が ARR 宣言と IDX = 0 宣言
  const holder = whilePath.parentPath;
  const list = holder && Array.isArray(holder.node.body) ? holder.node.body : null;
  if (!list) return null;
  const i = list.indexOf(w);
  if (i < 2) return null;

  const ordDecl = list[i - 2];
  const idxDecl = list[i - 1];
  if (!t.isVariableDeclaration(ordDecl) || ordDecl.declarations.length !== 1) return null;
  if (!t.isVariableDeclaration(idxDecl) || idxDecl.declarations.length !== 1) return null;
  const ordD = ordDecl.declarations[0];
  const idxD = idxDecl.declarations[0];
  if (!t.isIdentifier(ordD.id) || ordD.id.name !== arrName) return null;
  if (!t.isIdentifier(idxD.id) || idxD.id.name !== idxName) return null;
  if (!t.isNumericLiteral(idxD.init) || idxD.init.value !== 0) return null;

  // W6 ARR の init が <順序文字列>['split']('|')
  const init = ordD.init;
  if (!t.isCallExpression(init) || init.arguments.length !== 1) return null;
  if (!t.isMemberExpression(init.callee) || !init.callee.computed) return null;
  if (readStr(init.callee.property, whilePath.scope, ctx) !== 'split') return null;
  if (readStr(init.arguments[0], whilePath.scope, ctx) !== '|') return null;

  const orderStr = readStr(init.callee.object, whilePath.scope, ctx);
  if (orderStr === null) {
    // デッドコードにコピーされた壊れたディスパッチャなど。展開しないのが安全。
    stats.skipped.unreadableOrder += 1;
    return null;
  }
  const order = orderStr.split('|');

  // W7 全 case が文字列リテラル、default なし
  const labels = [];
  for (const c of sw.cases) {
    if (!c.test || !t.isStringLiteral(c.test)) return null;
    labels.push(c.test.value);
  }

  // W8 ラベル集合と順序集合が一致（重複なし）
  if (labels.length !== order.length) return null;
  if (new Set(labels).size !== labels.length) return null;
  const labelSet = new Set(labels);
  if (!order.every((k) => labelSet.has(k))) return null;

  // W9 ARR / IDX の参照が三つ組の内側だけ
  const scopeNodes = new Set([ordDecl, idxDecl, w]);
  for (const name of [arrName, idxName]) {
    const b = whilePath.scope.getBinding(name);
    if (!b) return null;
    for (const ref of b.referencePaths) {
      if (!isInsideAny(ref, scopeNodes)) return null;
    }
    for (const cp of b.constantViolations) {
      if (!isInsideAny(cp, scopeNodes)) return null;
    }
  }

  const cases = Object.create(null);
  for (const c of sw.cases) cases[c.test.value] = c;

  return { whilePath, holder, list, index: i, ordDecl, idxDecl, order, cases, switchNode: sw };
}

/**
 * ケース本体を取り出す。末尾のラベル無し continue はディスパッチャ由来なので落とす。
 * return / throw / break で終わるケースはそのまま。
 */
function extractCaseBody(switchCase) {
  const body = switchCase.consequent.slice();
  const last = body[body.length - 1];
  if (last && t.isContinueStatement(last) && !last.label) body.pop();
  return body;
}

/**
 * ディスパッチャを元の文順に戻して親ブロックへ直接展開する。
 * ★ ブロックで包んではいけない。case 内の var は他ケースから参照される。
 */
function unflattenDispatchers(ast, programScope, ctx, ledger, stats) {
  let anyChange = false;

  for (let pass = 0; pass < MAX_UNFLATTEN_PASSES; pass++) {
    let hit = null;
    traverse(ast, {
      WhileStatement(p) {
        if (hit) return;
        const m = matchDispatcher(p, ctx, stats);
        if (m) hit = m;
      }
    });

    if (!hit) break;

    ledger.removed(typeHistogram([hit.ordDecl, hit.idxDecl, hit.whilePath.node]));

    const out = [];
    for (const key of hit.order) out.push(...extractCaseBody(hit.cases[key]));

    ledger.added(typeHistogram(out));
    hit.list.splice(hit.index - 2, 3, ...out);

    stats.dispatchersUnflattened += 1;
    anyChange = true;
    stats.passes.unflatten += 1;

    // 構造を変えたので path キャッシュを作り直す
    programScope = refreshScope(ast);
  }

  return anyChange;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * 1 回ぶんの解除。parse -> Phase A〜F -> generate。
 * 呼び出し側（stripControlFlowFlattening）が、出力テキストが変わらなくなるまで回す。
 */
function stripOnce(code, options, ledger, stats) {
  const timeoutMs = options.timeout || 5000;
  const opts = { strict: Boolean(options.strict) };

  let ast;
  try {
    ast = parser.parse(code, PARSER_OPTIONS);
  } catch (err) {
    throw new StripError(`入力をパースできない: ${err.message}`);
  }

  let programScope = refreshScope(ast);

  // --- Phase A. 文字列層コンテキスト（読むだけ） ---------------------------
  const ctx = buildStringLayerContext(ast, programScope, timeoutMs);

  // --- Phase B〜E. 外側ループ ---------------------------------------------
  let round = 0;
  let changed = false;
  for (; round < MAX_OUTER_ROUNDS; round++) {
    let touched = false;
    if (foldStorages(ast, programScope, ctx, ledger, stats, opts)) touched = true;
    if (removeDeadStorages(ast, programScope, ctx, ledger, stats, opts)) touched = true;
    if (unflattenDispatchers(ast, programScope, ctx, ledger, stats)) touched = true;
    if (!touched) break;
    changed = true;
    stats.passes.outer += 1;
  }
  if (round >= MAX_OUTER_ROUNDS) {
    throw new StripError(`解除が ${MAX_OUTER_ROUNDS} ラウンドで収束しなかった`);
  }

  if (!changed) {
    // CFF が掛かっていない入力。何もせず通す（冪等）。
    return {
      code,
      changed: false,
      stringLayer: ctx ? { present: true, ...ctx.names, arrayStrings: ctx.arrayStrings } : { present: false }
    };
  }

  // --- Phase F. 残骸検査 ---------------------------------------------------
  programScope = refreshScope(ast);
  const leftovers = collectStorages(ast, ctx, opts);
  if (leftovers.size > 0) {
    stats.skipped.residualStorage = leftovers.size;
    if (opts.strict) {
      const names = [...leftovers.values()].map((s) => s.name).slice(0, 5);
      throw new StripError(
        `畳み残した control flow storage が ${leftovers.size} 件ある: ${names.join(', ')}`
      );
    }
  }

  if (opts.strict) {
    const s = stats.skipped;
    const total =
      s.nonCalleeFnRef +
      s.arityMismatch +
      s.thisBindingHazard +
      s.bindingNotPreserved +
      s.unresolvedDelegate +
      s.unreadableOrder;
    if (total > 0) {
      throw new StripError(`--strict: 畳めなかった箇所が ${total} 件ある ${JSON.stringify(s)}`);
    }
  }

  // --- Phase G. 1 行 compact で出力 ---------------------------------------
  const out = generate(ast, {
    compact: true,
    comments: false,
    jsescOption: { quotes: 'single', wrap: true }
  }).code;

  try {
    parser.parse(out, PARSER_OPTIONS);
  } catch (err) {
    throw new StripError(`生成したコードがパースできない: ${err.message}`);
  }

  // ★ code-compact / self-defending を守る。入力が 1 行なら出力も 1 行。
  if (!code.trimEnd().includes('\n') && out.trimEnd().includes('\n')) {
    throw new StripError('入力は 1 行だったのに出力に改行が入った（code-compact を解除している）');
  }

  return {
    code: out,
    changed: true,
    stringLayer: ctx
      ? { present: true, ...ctx.names, arrayStrings: ctx.arrayStrings }
      : { present: false }
  };
}

/**
 * コードから control-flow-flattening の層だけを剥がす。
 *
 * ★ 出力テキストが変わらなくなるまで parse -> 変換 -> generate を回す。
 *   在メモリの AST を書き換え続けると、Babel のスコープ情報が実際の木と
 *   わずかにずれて「本当は参照 0 なのに除去されない」が起きる。
 *   生成し直して読み直せばその曖昧さが消えるので、収束を素直に取りに行く。
 *   これで「2 回掛けても変わらない」が構造的に保証される。
 *
 * @returns {{code:string, changed:boolean, removedTypeCounts:object, addedTypeCounts:object,
 *            stringLayer:object, stats:object}}
 */
function stripControlFlowFlattening(code, options = {}) {
  const stats = {
    storagesFound: 0,
    storagesRemoved: 0,
    constFolds: 0,
    callFolds: 0,
    dispatchersUnflattened: 0,
    skipped: {
      nonCalleeFnRef: 0,
      arityMismatch: 0,
      thisBindingHazard: 0,
      bindingNotPreserved: 0,
      unresolvedDelegate: 0,
      unreadableOrder: 0,
      residualStorage: 0
    },
    passes: { fold: 0, remove: 0, unflatten: 0, outer: 0, reparse: 0 }
  };

  const removedTypeCounts = Object.create(null);
  const addedTypeCounts = Object.create(null);
  const ledger = {
    removed: (c) => addCounts(removedTypeCounts, c),
    added: (c) => addCounts(addedTypeCounts, c)
  };

  let current = code;
  let changed = false;
  let stringLayer = { present: false };

  for (let round = 0; round < MAX_REPARSE_ROUNDS; round++) {
    // skipped は「最後の一周で残ったもの」を見たいので毎周リセットする
    stats.skipped = {
      nonCalleeFnRef: 0,
      arityMismatch: 0,
      thisBindingHazard: 0,
      bindingNotPreserved: 0,
      unresolvedDelegate: 0,
      unreadableOrder: 0,
      residualStorage: 0
    };

    const r = stripOnce(current, options, ledger, stats);
    stringLayer = r.stringLayer;
    if (!r.changed || r.code === current) {
      if (round === 0) {
        return {
          code: current,
          changed: false,
          removedTypeCounts,
          addedTypeCounts,
          stringLayer,
          stats: { ...stats, reason: 'no-control-flow-flattening' }
        };
      }
      break;
    }
    current = r.code;
    changed = true;
    stats.passes.reparse += 1;

    if (round === MAX_REPARSE_ROUNDS - 1) {
      throw new StripError(`解除が ${MAX_REPARSE_ROUNDS} 回の読み直しで収束しなかった`);
    }
  }

  return { code: current, changed, removedTypeCounts, addedTypeCounts, stringLayer, stats };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `使い方:
  node strip-control-flow-flattening.js <input.js> [-o <output.js>] [--stats]
  node strip-control-flow-flattening.js --batch <indir> -o <outdir> [options]

オプション:
  -o, --out <path>       出力先。単一ファイルで省略すると stdout。
      --batch <dir>      ディレクトリ一括処理（-o は必須）
      --ext <suffix>     入力として拾う拡張子。既定 .js
      --suffix <suffix>  出力ファイル名の拡張子。既定 .js
      --continue-on-error 失敗しても続行し、最後にサマリを出す
      --timeout <ms>     デコーダ評価のタイムアウト。既定 5000
      --strict           畳めなかった箇所が 1 件でもあれば失敗にする
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
    strict: false,
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
    } else if (a === '--strict') {
      opts.strict = true;
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
  const result = stripControlFlowFlattening(code, { timeout: opts.timeout, strict: opts.strict });

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
  stripControlFlowFlattening,
  StripError,
  PARSER_OPTIONS,
  typeHistogram,
  collectStorages,
  buildStringLayerContext,
  matchDispatcher
};

if (require.main === module) {
  main();
}
