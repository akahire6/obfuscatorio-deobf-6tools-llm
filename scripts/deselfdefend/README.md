# strip-self-defending — self-defending だけを剥がす

javascript-obfuscator (obfuscator.io) で難読化されたスクリプトから、
**`self-defending` の層だけ**を決定論的に取り除くスクリプト。

想定している入力は 7 変換を同時に掛けたスクリプト
（`string-obfuscation` / `name-obfuscation` / `deadcode-injection` /
`debug-protection` / `control-flow-flattening` / `code-compact` / `self-defending`）。
そのうち **`self-defending` だけ**を解除し、残り 6 変換には一切触れない。
姉妹スクリプト `../destring/`（string-obfuscation 版）の self-defending 版で、
[`deobfuscate.js`](../../deobfuscate.js) が掛ける 6 段のうち 4 段目。

```bash
# 単一ファイル（-o を省くと stdout）
node strip-self-defending.js input.obf.js -o output.js

# ディレクトリ一括
node strip-self-defending.js --batch <indir> -o <outdir> \
     --ext .obf.js --suffix .nosd.js --continue-on-error

# 何をどれだけ消したか
node strip-self-defending.js input.obf.js --stats -o /dev/null
# -> {"controller":"_0x1b4335","callee":"_0x3a3b77","calleeVia":"cff:_0x169a2a.JuIrv",
#     "invocationVia":"cff:_0x169a2a.qbHnB","decoder":"_0xaf1e","marker":true,
#     "removedBytes":2418,"removedRanges":[[2372,3896],[3896,4760],[4760,4790]]}
```

初回のみ、リポジトリのルートで `npm install`（依存はルートの `package.json` にまとめてある）。

---

## 何を剥がすか

`selfDefending` 変換が生む 3 部品を特定し、**元ソースからその 3 文を切り出す**。

| # | 部品 | 形 |
|---|---|---|
| 1 | calls-controller | `var F=(function(){var firstCall=!![];return function(ctx,fn){..fn.apply(ctx,arguments)..};}());` |
| 2 | 自己検査 callee | `var S=F(this,function(){return S.toString().search('(((.+)+)+)+$').toString().constructor(S).search('(((.+)+)+)+$');});` |
| 3 | 起動文 | `S();` |

3 部品は同一ブロックにこの順で並ぶ。Program 直下とは限らず、関数の中にネストすることもある。

```js
// before
var _0x20d3b2=(function(){let _0x173420=!![];return function(_0x3c693f,_0x6bc97c){..}}());
var _0x58d431=_0x20d3b2(this,function(){..'(((.+)+)+)+$'..});
..業務コード..
_0x58d431();

// after
..業務コード..
```

### ★ 出力は「入力から 3 区間を切り出しただけ」

AST の再生成はしない。`node.start` / `node.end` で元のテキストから 3 文を削るだけなので、
**他 6 層が 1 バイトも変わらないことが自明**になり、`code-compact` も自動的に保たれる。
（`../destring/` は AST を再生成するので `layers` チェックを「文字列畳み込みで動かない
ノード種別」に限っていた。こちらは純粋な削除なので **全ノード種別**で厳密に照合できる。）

## 何を残すか

残り 6 変換には触れない。出力には次がそのまま残る:

- `string-obfuscation` の文字列配列。**`'(((.+)+)+)+$'` が配列に残るのは正しい。**
  配列要素を抜くとローテータの検査和が壊れるし、配列は string-obfuscation 層の資産。
  → **残骸の判定はテキスト検索ではなく構造で行う**（もう一度掛けて「対象なし」になるか）。
- `control-flow-flattening` の辞書オブジェクト。self-defending 専用だった転送関数
  （`'qbHnB':function(a){return a();}` など）は使われなくなるが、**消さない**。
- `deadcode-injection` のダミー分岐。self-defending 本体のコピーが死んだ分岐に
  紛れていることがあるが、到達不能なので残す。
- `debug-protection` 一式 / `name-obfuscation` の 16 進識別子 / `code-compact`。

---

## どうやって見つけるか

### debug-protection との弁別

両者とも **同じ形の calls-controller を独立に生成する**ので、ラッパの形だけでは区別できない。
決定的な違いは戻り値の扱い:

| | self-defending | debug-protection |
|---|---|---|
| 形 | `var S = F(this, fn); S();` | `F(this, fn)()` |
| 戻り値 | **変数に束縛する** | 束縛しない（即時実行） |
| 自己参照 | **fn の本体が S 自身を参照する** | なし |
| 正規表現 | `String.search(str)` に直接渡す | `new RegExp(..)` を 2 個作る |

**「呼び出しの戻り値を束縛した変数を、その引数の関数式が参照している」**——
この自己参照が self-defending 固有で、これを 1 次の網にしている。

### テキスト検索は使えない

目印 `(((.+)+)+)+$` の出現数はサンプルごとに 1〜3 回。deadcode-injection が
self-defending 本体のコピーを死んだ分岐にばら撒くうえ、文字列配列に吸われて本文から
消えることもある（自前コーパス 36 件中 5 件）。目印は**確証として記録するだけ**で、
検出条件にはしていない（値として確認できたのは 36 件中 16 件）。

### 文字列は「読む」が「書き戻さない」

`control-flow-flattening` は `F(this,fn)` を `DICT['JuIrv'](F,this,fn)` に、
`S()` を `DICT['qbHnB'](S)` に書き換える。しかも **その辞書キー自体が `DICT[dec(0x1cf)]`
の形で文字列配列に入る**ことがあり、リテラルキーしか見ない検出器は
**36 サンプル中 29 件**しか当たらない。

そこで `../destring/strip-string-obfuscation.js` が export している部品検出器
（`matchStringArrayFunction` / `matchDecoderFunction` / `matchRotatorStatement` / `buildDecoder`）
を借りて、配列関数・デコーダ・ローテータの 3 つだけを `node:vm` の新しいコンテキストで
実行し、辞書キーとメソッド名を照合する。これで **36/36**。
**出力の文字列表現は一切変えない**（読むだけ）。

> 実測: 生成呼び出しが辞書経由だったもの 7/36、起動文が辞書経由だったもの 10/36。

### 確定条件

次を全部満たすものだけを消す。1 つでも欠ければ**出力せず非ゼロ終了**する。

1. 生成呼び出しを読み替えて `F(this, function(){..})` の形になる
2. 自己検査の連鎖に `toString` / `search` / `constructor` が揃っている
3. `S` を 0 引数で呼ぶ文がちょうど 1 個
4. `F` が calls-controller の形をしていて、**参照数がちょうど 1**
   （debug-protection と共有されていたら消さない）
5. 3 部品が同一ブロックの兄弟で、宣言子が 1 個ずつ、並び順が `F → S → 起動文`

## 失敗するとき

自己参照の網には掛かったが確定条件を満たさない場合は、**出力せず非ゼロ終了する**。
黙って壊れたコードを出さない。

`self-defending` が掛かっていない入力は、**入力をそのまま出力**して正常終了する
（冪等。同じファイルに 2 回掛けても変わらない）。

### 対応していない設定

`stringArrayEncoding: ["base64","rc4"]` + `stringArrayCallsTransform` + `splitStrings`
を組み合わせた設定（`configs/hard-self.json`）は文字列配列デコーダを組み立てられず、
辞書キーもメソッド名も読めないので **対応していない**。
この場合は安全弁が働いて必ず失敗する（`verify.js` の `refuse` チェックで担保）。

---

## 検証

**ベンチマークのデータセットは開発にも検証にも使っていない。**
特定のデータへの過適合を避けるため、検証コーパスはすべてここで新しく生成する。

```bash
node gen-corpus.js   # testdata/src/*.js を難読化して testdata/obf/ を作る
node verify.js       # 全サンプルを検査（整形チェックを含むので 2〜3 分かかる）
node verify.js --no-beautify   # 整形チェックを飛ばして速く回す
```

- `testdata/src/*.js` — `../destring/` と共通の書き下ろし 12 本
  （ES5 のみ / ES2015+ / テンプレートリテラル / 改行・絵文字・ゼロ幅文字を含む文字列 /
  計算プロパティ / 多重クロージャ / 正規表現と JSON / 標準入力 / 文字列が極端に少ない /
  再帰と try-catch / ジェネレータと async / 文字列を持たないプログラム）。
- 難読化設定は `configs/` の 5 本。シードを変えると部品の出現順序も辞書の形も変わるので、
  本命の `seven` は 3 シードで回す。

`verify.js` がサンプルごとに見るもの:

| 項目 | 内容 |
|---|---|
| `strip` | self-defending を検出して除去できた |
| `parse` | 出力が JS としてパースできる |
| `bytes` | 出力が「入力から報告した 3 区間を切り出しただけ」と完全に一致する |
| `layers` | **全ノード種別**で 入力 − 除去部品 = 出力 |
| `compact` | 入力が 1 行なら出力も 1 行 |
| `residue` | もう一度掛けると「対象なし」になる（= 残骸ゼロ） |
| `idem` | 2 回目の適用で 1 バイトも変わらない |
| `marks` | debug-protection の目印が出力に残っている |
| `behave` | 原本・難読化後・解除後の 3 つが同じ stdout と終了コードを返す |
| `trap` | **解除前**のコードは整形すると罠が作動する（3 秒で返ってこない） |
| `beautify` | **解除後**のコードは整形しても罠に落ちず、原本と同じ結果を返す |

`layers` が他 6 変換を触っていないことの機械的な証明。
`trap` と `beautify` の対が **「消したものが本物の罠だった」ことの直接証明**で、
これは self-defending 版にしか書けないチェック。
既存の解除ツール（js-deobfuscator / synchrony）が 7 変換を同時に掛けたコードで陥る
「整形はするが罠を除去しないので、自分で罠を作動させる」という失敗モードを、このスクリプトが解消していることをそのまま測っている。

現状の結果:

```
seven (36 サンプル)        36/36 PASS
self-only (12 サンプル)    12/12 PASS
no-self（負例）            12/12 PASS  ← 6変換を1バイトも変えないこと
debug-only（負例）         12/12 PASS  ← 紛らわしい debug-protection を消さないこと
hard-self（対象外設定）    12/12 PASS  ← 理由つきで失敗すること
非対象入力                 12/12 PASS  ← 難読化していないコードを壊さないこと
```

削減率（`seven` 36 件）: 最小 5.6% / 中央 13.4% / 最大 27.0%。

---

## 依存関係の注意

このスクリプトは `../destring/strip-string-obfuscation.js` を require する
（`dedead` / `decff` / `dedebug` も同じ）。
`../destring/` を消したり移動したりするとこのスクリプトは動かなくなる。
