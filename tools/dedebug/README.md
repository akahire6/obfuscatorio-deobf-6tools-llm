# strip-debug-protection — debug-protection だけを剥がす

javascript-obfuscator (obfuscator.io) で難読化されたスクリプトから、
**`debug-protection` の層だけ**を決定論的に取り除くツール。

想定している入力は 7 変換を同時に掛けたスクリプト
（`string-obfuscation` / `name-obfuscation` / `deadcode-injection` /
`debug-protection` / `control-flow-flattening` / `code-compact` / `self-defending`）。
そのうち **`debug-protection` だけ**を解除し、残り 6 変換には一切触れない。
姉妹ツール [`../destring/`](../destring/) の debug-protection 版で、
[`deobfuscate.js`](../../deobfuscate.js) が掛ける 6 段のうち 5 段目。

```bash
# 単一ファイル（-o を省くと stdout）
node strip-debug-protection.js input.obf.js -o output.js

# ディレクトリ一括
node strip-debug-protection.js --batch <indir> -o <outdir> \
     --ext .obf.js --suffix .dedbg.js --continue-on-error

# 何をどれだけ剥がしたか
node strip-debug-protection.js input.obf.js --stats -o /dev/null
# -> {"debugProtectionFunction":"_0x5723fd","innerFunction":"_0x42f772",
#     "debuggerBodies":["while (true) {}","debugger"],"bootstrapStatements":1,
#     "controller":"_0x286f44","controllerShared":false,
#     "stringsResolvedByDecoder":true,"deadFragments":0,"removedBytes":5909, ...}
```

初回のみ、リポジトリのルートで `npm install`（依存はルートの `package.json` にまとめてある）。

---

## 何を剥がすか

`debugProtection` が生む 3 部品を特定して、まるごと取り除く。

| # | 部品 | 形 |
|---|---|---|
| 1 | 本体 | `function DPF(ret){ function debuggerProtection(c){ .. ['constructor']('debu'+'gger')['call']('action') .. } try{ .. }catch(y){} }` |
| 2 | 起動部 | `(function(){ C(this, function(){ .. DPF('init') .. })(); }())`<br>`debugProtectionInterval > 0` なら `setInterval` 版がもう 1 文 |
| 3 | calls-controller | `var C=(function(){var firstCall=!![];return function(ctx,fn){..}}())` |

### ★ 3 部品はトップレベルに並んでいない

難読化器は **起動部と controller をユーザ関数の本体の中に注入する**（実測: `wordCount` の中）。
本体だけが Program 直下に来る。だから削除の単位は「トップレベル文」ではなく
**「Program か BlockStatement の直下にある文」**。

### ★ 検出は「文字列を読む」が「書き戻さない」

7 変換同時では `'debu'` `'gger'` `'while (true) {}'` が全部デコーダ呼び出しになっていて
ソース上に見えない。さらに control-flow-flattening が辞書経由
（`_0x3f2479['pNevn']` / `_0x3f2479['kYgwU']('debu', ..)`）に変える。
`'constructor'` というプロパティ名すら文字列配列に入る。

そこで小さな評価器を持ち、`../destring` のデコーダ組み立てを借りて値を求める。
**求めた値は判定にしか使わない。コードは 1 バイトも書き換えない。**

検出の決定打は「内側関数のどこかに `X['constructor'](A)` があり、
`A` が `debugger` か `while (true) {}` に評価できる」こと。
識別子名にも、CFF の形にも、文の位置にも依存しない。

起動部は構造マッチではなく **本体の binding の参照から辿る**。
controller は起動部の中から参照されている変数のうち
「引数なし IIFE で 2 引数の関数を返すもの」を選び、
**参照が起動部の外にもあれば self-defending と共有しているとみなして残す**。

## 何を残すか

残り 6 変換には触れない。出力には次がそのまま残る:

- `string-obfuscation` の文字列配列（**debug-protection が使っていた文字列が
  配列に残るのが正しい**。配列に触れば string-obfuscation を解除したことになる）
- `deadcode-injection` のダミー分岐
- `control-flow-flattening` の辞書オブジェクト（誰も使わないエントリが残るのも正しい）
- `self-defending` のラッパー
- `name-obfuscation` の 16 進識別子
- `code-compact`

### ★ 死んだ分岐に残る debug-protection の断片は残す

`deadcode-injection` は debug-protection のコード片を他の関数の死んだ枝にコピーする
（自前コーパス 48 サンプル中、複数で実在）。**これは deadcode-injection の層なので消さない。**
到達不能なので `debugger` が実行されることはない。`stats.deadFragments` に数を報告する。

到達可能な位置に `debugger` 生成が残る場合は、解除しきれていないので**失敗する**。

### ★ 出力は 1 行のまま

整形して出力してはいけない。理由は 2 つ、destring と同じ。

1. `code-compact` まで解除したことになり「debug-protection のみ解除」でなくなる。
2. **self-defending が発火する。** `fn.toString().search('(((.+)+)+)+$')` は
   改行が入った途端に catastrophic backtracking を起こし事実上ハングする。

## 失敗するとき

確信が持てない状況では**出力せず非ゼロ終了する**。黙って壊れたコードを出さない。

- 本体の候補が 2 個以上見つかった
- 本体を参照している文が起動部の形をしていない（ユーザコードを巻き込む恐れ）
- 起動部から controller の候補が 2 個以上見つかった
- 削除後に、削除した名前への到達可能な参照が残る
- 到達可能な位置に `debugger` 生成が残る
- **本体の構造をした関数があるのに、中の文字列を復号できない**（下記）

`debug-protection` が掛かっていない入力は、**入力をそのまま出力**して正常終了する
（冪等。同じファイルに 2 回掛けても変わらない）。

### 対応していない設定

`stringArrayWrappersType: "function"` + `stringArrayCallsTransform` + `base64/rc4`
（`configs/hard.json`）は**対応していない**。文字列を復号できないため。

この場合に怖いのは「文字列が読めない → debug-protection は無いと誤判定 → 黙って素通し」
という偽陰性なので、**構造だけ当たった候補があり、その中に復号できない文字列がある**なら
必ず失敗させる。`configs/hard.json` の 16 サンプル全件でこの安全弁が働くことを確認している。

## destring と併用するとき

`destring → dedebug` の順に掛けるのが安全。逆順（dedebug → destring）でも両ツールとも
成功するが、debug-protection が使っていた文字列が「誰も参照しない配列要素」として残るため、
**destring 側の `verify.js` の `strings` 監査（配列の全要素を説明できること）が破れる**。

---

## 検証

**ベンチマークのデータセットは開発にも検証にも使っていない。**
特定のデータへの過適合を避けるため、検証コーパスはすべてここで新しく生成する。

```bash
node gen-corpus.js   # testdata/src/*.js を難読化して testdata/obf/ を作る
node verify.js       # 全サンプルを検査
```

- `testdata/src/*.js` — 16 本。`../destring/testdata/src/` の 12 本に、
  debug-protection 固有の罠を 4 本足した:
  - `13-dpf-lookalike.js` — 本体に構造だけ似せた偽物（自己再帰する内側関数 + 空 catch）
  - `14-user-function-ctor.js` — ユーザが正当に `new Function(..)` を使う
  - `15-wrapped-in-iife.js` — プログラム全体が IIFE で包まれている
  - `16-user-setinterval.js` — ユーザが正当に `setInterval` を使う
- 難読化設定は 5 つ。`seven` だけ 3 シード（配列の並びも部品の出現順も変わる）。

| config | 内容 | 期待 |
|---|---|---|
| `seven` | 7 変換すべて | 解除できる |
| `debug-only` | debug-protection 単体（`mangled` 名・整形あり） | 解除できる |
| `debug-interval` | `debugProtectionInterval: 4000` | 起動部 2 文とも消える |
| `no-debug` | debug-protection 以外の 6 変換 | **1 バイトも変えない** |
| `hard` | 復号できない設定 + debug-protection | **理由つきで失敗する** |

`verify.js` がサンプルごとに見るもの:

| 項目 | 内容 |
|---|---|
| `strip` | debug-protection を検出して解除できた |
| `parse` | 出力が JS としてパースできる |
| `residue` | 削除した部品の宣言が減っている（同名シャドーイングがあるので AST で数える） |
| `idem` | もう一度掛けると「対象なし」で、1 バイトも変わらない |
| `layers` | **難読化後 − 除去分 = 解除後 が全ノード種別で厳密に成立する** |
| `frozen` | 変化した文が削除箇所の周りだけに閉じている |
| `strings` | 文字列配列関数・デコーダ・ローテータがバイト単位で不変 |
| `marks` | self-defending の目印 / 16 進識別子 / 文字列配列が残っている |
| `compact` | 入力が 1 行なら出力も 1 行 |
| `nodebug` | **動的検証**（下記） |
| `behave` | 原本・難読化後・解除後の 3 つが同じ stdout と終了コードを返す |

### `layers` が「他 6 変換に触れていない」ことの証明

destring は文字列を畳み込むのでノード数が動く種別があり、20 種別の許容リストが要った。
このツールは**削除しかしない**ので、**全ノード種別**について

```
難読化後の個数 − 除去した部品の個数 = 解除後の個数
```

が厳密に成立する。デッドコードの分岐や CFF 辞書を 1 つでも畳んでいれば破れる。

### `nodebug` — この層が本当に消えたことの動的証明

`fn['constructor']('debu'+'gger')` の `fn.constructor` はプロトタイプチェーンをたどって
`Function.prototype.constructor` に届く。そこを差し替えれば、
**`debugger` を作ろうとしたことをすべて捕捉できる**。
`spy-preload.js` を `node -r` で本体より先に読み込ませ、子プロセスで実測する。

```
原本   dbg=0
難読化 dbg>0            ← 検査が空振りしていないことの保証
解除後 dbg / wt / iv がすべて原本と同じ
```

- `while (true) {}` は改竄検知が発火したときの罠。スパイで潰さないと verify がハングする。
  `wt > 0` は「壊した」ことのシグナルなのでそのまま失敗条件にしている。
- `setInterval` は `unref()` する。`debugProtectionInterval > 0` の起動部を消し損ねると
  解除後のプロセスが永遠に終わらないので、`iv` を原本と比べて検出する。
- 判定はすべて**原本を基準**にする。ユーザプログラム自身が `new Function` や
  `setInterval` を使っていても誤検出しない（`14-` と `16-` がその検査）。

現状の結果:

```
seven (48 サンプル)           48/48 PASS
debug-only (16 サンプル)      16/16 PASS
debug-interval (16 サンプル)  16/16 PASS
no-debug（負例）              16/16 PASS  ← 1 バイトも変えないこと
hard（対象外設定）            16/16 PASS  ← 理由つきで失敗すること
素のソース（非対象入力）      16/16 PASS  ← 難読化していないコードを壊さないこと
```

## 姉妹ツール

同じ流儀で層ごとに 1 つずつ作られている:
`../destring/`（string-obfuscation） / `../deselfdefend/`（self-defending） /
`../decompact/`（code-compact） / `../decff/` / `../dedead/`。

## `../destring/` への変更

`strip-string-obfuscation.js` の `module.exports` に
`matchStringArrayFunction` / `matchDecoderFunction` / `matchRotatorStatement` /
`buildDecoder` / `literalArgValue` を追加しただけ。**剥がす処理には手を入れていない**
（destring の `verify.js` は 73/73 PASS のまま）。
