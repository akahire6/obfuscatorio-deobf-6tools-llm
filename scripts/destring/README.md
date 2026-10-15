# strip-string-obfuscation — string-obfuscation だけを剥がす

javascript-obfuscator (obfuscator.io) で難読化されたスクリプトから、
**`string-obfuscation` の層だけ**を決定論的に取り除くスクリプト。

想定している入力は 7 変換を同時に掛けたスクリプト
（`string-obfuscation` / `name-obfuscation` / `deadcode-injection` /
`debug-protection` / `control-flow-flattening` / `code-compact` / `self-defending`）。
そのうち **`string-obfuscation` だけ**を解除し、残り 6 変換には一切触れない。

```bash
# 単一ファイル（-o を省くと stdout）
node strip-string-obfuscation.js input.obf.js -o output.js

# ディレクトリ一括
node strip-string-obfuscation.js --batch <indir> -o <outdir> \
     --ext .obf.js --suffix .destr.js --continue-on-error

# 何をどれだけ剥がしたか
node strip-string-obfuscation.js input.obf.js --stats -o /dev/null
# -> {"stringArrayFunction":"_0xe969","decoderFunction":"_0x5b2c","rotator":true,
#     "arrayLength":138,"wrapperAliases":25,"foldedCalls":171}
```

初回のみ、リポジトリのルートで `npm install`（依存はルートの `package.json` にまとめてある）。

---

## 何を剥がすか

`stringArray` 変換が生む 4 つの部品を特定し、呼び出しを実リテラルに畳み込んでから
部品ごと削除する。

| # | 部品 | 形 |
|---|---|---|
| 1 | 文字列配列関数 | `function F(){var A=['..','..'];F=function(){return A;};return F();}` |
| 2 | デコーダ関数 | `function D(a,b){a=a-OFF;var A=F();return A[a];}` |
| 3 | ローテータ IIFE | `(function(f,n){var A=f();while(!![]){try{..}catch(e){A.push(A.shift());}}}(F,0x1950f))` |
| 4 | ラッパー別名 | `var W1=D;` / 関数内の `const W2=W1;`（chained calls で多段になる） |

```js
// before
var _0x29d757=_0x5b2c;(function(_0x1c0c6b,_0x1f0fd5){ ...rotator... }(_0xe969,0x1950f));
var lines=require('fs')[_0x29d757(0x1f0)](_0x29d757(0x243),_0x29d757(0x1dc));
function _0xe969(){var _0x5022df=['readFileSync','/dev/stdin','utf8',...];...}
function _0x5b2c(_0x245361,_0x3bb17f){ ...decoder... }

// after
var lines=require('fs')['readFileSync']('/dev/stdin','utf8');
```

**デコーダの中身は読み解かない。** 配列関数・デコーダ・ローテータの 3 つだけを
`node:vm` の新しいコンテキストに取り出して実行し、ローテータが配列を最終的な
回転状態に落ち着かせたあとで実際に `decode(idx)` を呼ぶ。
インデックスオフセット・シャッフル・回転の内訳に依存しないので、
これらの設定が変わっても動く。debug-protection / self-defending のコードは
**一切実行しない**（3 部品は `parseInt` 以外の外部依存を持たない自己完結コード）。

別名の解決には Babel のスコープ束縛 (`scope.getBinding`) を使う。
同名の変数が別スコープにあっても取り違えない。

## 何を残すか

残り 6 変換には触れない。出力には次がそのまま残る:

- `deadcode-injection` のダミー分岐
- `control-flow-flattening` の辞書オブジェクト（`_0x13a459['ZJvAy']` 形式の間接呼び出し）
- `debug-protection` の検査ループ
- `self-defending` のラッパー
- `name-obfuscation` の 16 進識別子
- `code-compact`（後述）

### ★ 出力は 1 行のまま

整形して出力してはいけない。理由は 2 つある。

1. `code-compact` まで解除したことになり「string-obfuscation のみ解除」でなくなる。
2. **self-defending が発火する。** self-defending は
   `fn.toString().search('(((.+)+)+)+$')` で整形を検出する仕掛けで、
   改行が入った途端に catastrophic backtracking を起こし事実上ハングする。
   1 行のままなら即座に一致して素通りする。

## 失敗するとき

確信が持てない状況では**出力せず非ゼロ終了する**。黙って壊れたコードを出さない。

- デコーダ呼び出しの引数がリテラルでない（変数・式）
- デコードが例外を投げた／文字列以外を返した
- 畳み込み後もデコーダ・別名・配列関数への参照が残っている
- 配列関数は見つかったがデコーダが見つからない

`string-obfuscation` が掛かっていない入力は、**入力をそのまま出力**して正常終了する
（冪等。同じファイルに 2 回掛けても変わらない）。

### 対応していない設定

`stringArrayWrappersType: "function"` / `stringArrayCallsTransform: true` /
`stringArrayEncoding: ["base64","rc4"]` を組み合わせた設定（`configs/hard.json`）は
**対応していない**。この場合は上の安全弁が働いて必ず失敗する。
壊れたコードが出ることはない（`verify.js` の `refuse` チェックで担保）。

---

## 検証

**ベンチマークのデータセットは開発にも検証にも使っていない。**
特定のデータへの過適合を避けるため、検証コーパスはすべてここで新しく生成する。

```bash
node gen-corpus.js   # testdata/src/*.js を難読化して testdata/obf/ を作る
node verify.js       # 全サンプルを検査
```

- `testdata/src/*.js` — このスクリプトのために書き下ろした 12 本のプログラム。
  ES5 のみ / ES2015+ / テンプレートリテラル / 改行・絵文字・ゼロ幅文字を含む文字列 /
  計算プロパティ / 多重クロージャ / 正規表現と JSON / 標準入力 / 文字列が極端に少ない /
  再帰と try-catch / ジェネレータと async / 文字列を持たないプログラム。
- `configs/seven.json` を 3 シード、`configs/string-only.json` を 1 シードで難読化。
  シードを変えると配列の並びも部品の出現順序も変わるので、形の揺れを当てられる。
- `gen-legacy-fixture.js` — javascript-obfuscator 4.x 系の**自己書き換えデコーダ**
  （`D = function(x,y){...}; return D(a,b);`）の形を一から組み立てたフィクスチャ。
  手元の 5.7.0 では生成できないが実在する形なので、検査和が実際に成立する形で再現している。

`verify.js` がサンプルごとに見るもの:

| 項目 | 内容 |
|---|---|
| `strip` | string-obfuscation を検出して解除できた |
| `parse` | 出力が JS としてパースできる |
| `residue` | もう一度掛けると「対象なし」になる（= 残骸ゼロ） |
| `idem` | 2 回目の適用で 1 バイトも変わらない |
| `strings` | 配列の全要素が「コードに戻された」か「ローテータの検査和に消費された」かで説明できる |
| `compact` | 入力が 1 行なら出力も 1 行 |
| `layers` | **除去した部品以外はノードが 1 つも変わっていない** |
| `marks` | self-defending / debug-protection の目印が出力に残っている |
| `behave` | 原本・難読化後・解除後の 3 つが同じ stdout と終了コードを返す |

`layers` が他 6 変換を触っていないことの機械的な証明になっている。
文字列の畳み込み（`D(0x1)` → `'foo'`）では増減しないノード種別
（`IfStatement` / `ObjectExpression` / `FunctionExpression` / `TryStatement` など 20 種）
について、**難読化後の個数 − 除去した部品の個数 = 解除後の個数** が厳密に成立することを見る。
デッドコードの分岐や制御フロー辞書を 1 つでも畳んでいれば、この等式が破れる。

現状の結果:

```
seven (36 サンプル)        36/36 PASS
string-only (12 サンプル)  12/12 PASS
legacy (1 サンプル)         1/1  PASS
hard（対象外設定）         12/12 PASS  ← 理由つきで失敗すること
非対象入力                 12/12 PASS  ← 難読化していないコードを壊さないこと
```
