# strip-code-compact — code-compact だけを剥がす

javascript-obfuscator (obfuscator.io) で難読化されたスクリプトから、
**`code-compact` の層だけ**を決定論的に取り除くスクリプト。

想定している入力は 7 変換を同時に掛けたスクリプト
（`string-obfuscation` / `name-obfuscation` / `deadcode-injection` /
`debug-protection` / `control-flow-flattening` / `code-compact` / `self-defending`）。
そのうち **`code-compact` だけ**を解除し、残り 6 変換には一切触れない。
[`deobfuscate.js`](../../deobfuscate.js) が掛ける 6 段の**最後（6 段目）**。
姉妹スクリプトは [`../destring/`](../destring/)（string-obfuscation 版）や
[`../deselfdefend/`](../deselfdefend/)（self-defending 版）など。

```bash
# 単一ファイル（-o を省くと stdout）
node strip-code-compact.js input.obf.js -o output.js

# 実行可能にしたいとき（self-defending の検査対象だけ 1 行に残す）
node strip-code-compact.js input.obf.js -o output.js --keep-self-defending

# ディレクトリ一括
node strip-code-compact.js --batch <indir> -o <outdir> \
     --ext .obf.js --suffix .decompact.js --continue-on-error

# 何をどれだけやったか
node strip-code-compact.js input.obf.js --stats -o /dev/null
# -> {"lines":561,"bytes":20470,"guardsKept":0,"astIdentical":true,
#     "selfDefending":true,"structuralNewlines":0,"noop":false}
```

初回のみ、リポジトリのルートで `npm install`（依存はルートの `package.json` にまとめてある）。

---

## 何を剥がすか

**`code-compact` は変換ではなくコード生成オプション `compact: true` ただ 1 つ**で、
空白・改行・インデントを落とすだけ。JsDeObsBench の code-compact 単体の設定も、
既定との差分は `"compact": true` のみ。

したがって **解除 = 整形のみ**。AST は 1 ノードも変わらない。

```js
// before （1 行）
var _0x29d757=_0x5b2c;(function(_0x1c0c6b,_0x1f0fd5){var _0x30c1a8=_0x1c0c6b();while(!![]){...

// after
var _0x29d757 = _0x5b2c;
(function (_0x1c0c6b, _0x1f0fd5) {
    var _0x30c1a8 = _0x1c0c6b();
    while (!![]) {
        ...
```

### ★ 整形は「難読化器が `compact:false` で出したはずのコード」を再現する

自前の整形規則は持たない。javascript-obfuscator が内部で使っているのと**同じ**
`@javascript-obfuscator/escodegen` で生成するので、self-defending を含まない構成では
**難読化器自身の `compact:false` 出力とバイト単位で一致する**（下の `gold` 検査）。

```js
escodegen.generate(ast, {
  parse: (s) => acorn.parse(s, ACORN_BASE),   // ★ これが無いと 0x92 が 146 になる
  verbatim: 'x-verbatim-property',
  format: { compact: false }
});
```

`parse` オプションを渡さないと escodegen がリテラルを `value` から刷り直すため、
**16 進リテラルが 10 進に化けて `name-obfuscation` 以外の層を壊す**。必須。

## 何を残すか

残り 6 変換には触れない。出力には次がそのまま残る:

- `deadcode-injection` のダミー分岐
- `control-flow-flattening` の辞書オブジェクト
- `debug-protection` の検査ループ
- `self-defending` のラッパー
- `name-obfuscation` の 16 進識別子
- `string-obfuscation` の文字列配列・デコーダ・ローテータ

### ★ ブラケット記法・16 進リテラル・`\x` エスケープには触らない

`obj['method']` / `0x1f` / `'\x0a'` は **`compact:false` の出力にも同じように現れる**
（javascript-obfuscator の常時オンの変換や、別の層が作るもの）。
これらを「読みやすく」戻すと `code-compact` 以外の層まで解除したことになる。

---

## ★★ code-compact と self-defending は独立に剥がせない

**既定モードの出力は、7 変換入力では実行するとハングする。** これは不具合ではない。

`selfDefending` は `SelfDefendingTemplate` の

```js
X.toString().search('(((.+)+)+)+$')
```

で整形を検出する仕掛けで、`X` は呼び出しコントローラ (`SingleCallControllerTemplate`) の
`firstCall ? function(){...} : function(){}` の **consequent 側の関数**。
改行が入ると `.` が改行を跨げなくなり、catastrophic backtracking で事実上ハングする。
1 行のままなら即座に一致して素通りする。

さらに **javascript-obfuscator は `selfDefending: true` のとき `compact` を強制的に true にする**:

```js
SelfDefendingRule = (e) => (e.selfDefending && (e = { ...e, compact: true, selfDefending: true }), e);
```

つまり **7 変換構成の「compact でない正解」は難読化器からは生成できない**。
`compact:false` を指定しても同じ 1 行出力が返る（実測）。

### `--keep-self-defending`

検査対象の関数だけを 1 行のまま残し、それ以外を整形する。出力は実行できる。

```bash
node strip-code-compact.js in.obf.js -o out.js --keep-self-defending
# -> guardsKept:2、530 行に整形され、node out.js が原本と同じ出力を返す
```

**トレードオフ**: 厳密にはその関数ぶん（実測で 1 ファイルあたり 2 個）の `code-compact` が
残るので、「完全な code-compact 解除」ではない。
対象が 1 つも見つからなければ**失敗して終了する**（黙ってハングするファイルを出さない）。

### もう一つの道: 先に self-defending を剥がす

`../deselfdefend/` を掛けてからこのスクリプトを掛けると、`--keep-self-defending` 無しの
**完全な整形**でも正常に動く。`testdata/obf/seven/` の 45 件全件で、原本と同じ
stdout / 終了コードを返すことを確認した。

```bash
node ../deselfdefend/strip-self-defending.js in.obf.js -o /tmp/nosd.js
node strip-code-compact.js /tmp/nosd.js -o /tmp/out.js
```

逆順（整形してから self-defending を剥がす）は、最初の整形の時点でハングするので成立しない。
**この2層には順序がある。** `deobfuscate.js` が `self-defending` を 4 段目、
`code-compact` を最後に置いているのは、これが唯一成立する向きだからである。

---

## 失敗するとき

確信が持てない状況では**出力せず非ゼロ終了する**。黙って壊れたコードを出さない。

- 入力が JS としてパースできない（script / module の両方で失敗）
- 生成したコードが再パースできない
- **整形前後で AST が一致しない**（= 別の層に触れてしまっている）
- `--keep-self-defending` を指定したのに検査対象が見つからない

`code-compact` が掛かっていない入力（= 既に整形済み）は、**入力をそのまま出力して
正常終了**する（冪等。同じファイルに 2 回掛けても 1 バイトも変わらない）。
`--force` を付けると強制的に整形し直す。

### ★ 「整形済み」の判定に改行の有無を使っていない

改行を含むテンプレートリテラルや文字列を持つプログラムは、`compact: true` で
出力してもソースに改行が現れる。素朴に改行を数えると「既に整形済み」と誤判定し、
**黙って何もしないまま正常終了してしまう**。
そこで **リテラルとコメントの範囲を除いた「構造上の改行」**を数え、
それが 0 のときだけ code-compact が掛かっているとみなす
（`structuralNewlineCount()`。`--stats` の `structuralNewlines`）。

---

## 検証

**ベンチマークのデータセットは開発にも検証にも使っていない。**
特定のデータへの過適合を避けるため、検証コーパスはすべてここで新しく生成する。

```bash
node gen-corpus.js   # testdata/src/*.js を難読化して testdata/obf/ を作る
node verify.js       # 全サンプルを検査
```

- `testdata/src/*.js` — 15 本のプログラム。`../destring/testdata/src/` の 12 本
  （ES5 のみ / ES2015+ / テンプレートリテラル / 改行・絵文字・ゼロ幅文字を含む文字列 /
  計算プロパティ / 多重クロージャ / 正規表現と JSON / 標準入力 / 文字列が極端に少ない /
  再帰と try-catch / ジェネレータと async / 文字列を持たないプログラム）に、
  **整形を攻める 3 本**を足したもの。このスクリプトのリスクは escodegen の再生成にしか無いため:
  - `13-asi-hazards.js` — 自動セミコロン挿入の罠（`[` / `(` で始まる行、
    `return` の直後、前置・後置インクリメント、タグ付きテンプレート）
  - `14-syntax-corners.js` — ラベル付き文と `continue lbl` / `do-while` /
    カンマ演算子 / `for (var k = ('v' in box); ...)` / getter・setter / `debugger` /
    正規表現と除算の見分け
  - `15-multiline-literals.js` — 改行を含むテンプレートリテラルと文字列、行継続、
    タグ付きテンプレートの `raw`
- `configs/compact-only.json` を 1 シード、`configs/six-nosd.json` と
  `configs/seven.json` を 3 シードずつで難読化。

`gen-corpus.js` は **入力と正解 (gold) を対で**書く。同じ seed で `compact` だけ
`false` にして再難読化すれば、バイト単位の正解が手に入るため。
`seven` では上記の `SelfDefendingRule` により正解が作れないので gold を書かず、
`testdata/obf/seven/no-gold.txt` に理由を残す。

`verify.js` がサンプルごとに見るもの:

| 項目 | 内容 |
|---|---|
| `strip` | code-compact を検出して整形できた |
| `parse` | 出力が JS としてパースできる |
| **`gold`** | **難読化器が `compact:false` で出すコードとバイト単位で一致する** |
| **`ast`** | **入力と出力の AST が完全に一致する（他 6 変換に触れていない証明）** |
| `multiline` | 入力は構造上 1 行、出力は複数行（= 実際に解除された） |
| `idem` | もう一度掛けると「対象なし」になり 1 バイトも変わらない |
| `marks` | self-defending / debug-protection の目印が出力に残っている |
| `behave` | 原本・難読化後・解除後の 3 つが同じ stdout と終了コードを返す |
| **`trap`** | **`seven` の既定出力は実行がタイムアウトする**（self-defending 発火の記録） |
| **`guard`** | **`seven` を `--keep-self-defending` で解除した出力は原本と同じ結果を返す** |

`ast` が「他 6 変換を触っていない」ことの機械的な証明になっている。
destring の `layers`（ノード種別のヒストグラム等式）より強い検査で、
**位置情報以外のすべて（リテラルの `raw` まで）の完全一致**を要求する。
整形は AST を 1 ノードも変えないので、ここは厳密一致でなければならない。
`verify.js` の比較関数は本体とは独立に書いてあるので、本体の自己検査が
壊れていても検出できる。

`trap` は「失敗が期待値」の検査。これが PASS することが
**code-compact と self-defending を独立に剥がせない**ことの実証になる。

現状の結果:

```
compact-only (15 サンプル)   15/15 PASS   ← gold バイト一致
six-nosd     (45 サンプル)   45/45 PASS   ← gold バイト一致 + behave 一致
seven        (45 サンプル)   45/45 PASS   ← ast 同型 + marks + trap + guard
整形済み入力 (60 サンプル)   60/60 PASS   ← 素通しすること
非対象入力   (15 サンプル)   15/15 PASS   ← 難読化していないコードを壊さないこと
```

手で 1 件確かめる:

```bash
# gold オラクル: 難読化器の compact:false 出力とバイト一致
node strip-code-compact.js testdata/obf/six-nosd/01-es5-basic.s1.obf.js -o /tmp/g.js
cmp testdata/obf/six-nosd/01-es5-basic.s1.gold.js /tmp/g.js   # -> 差分なし

# 既定モード: 整形されるが実行はハングする
node strip-code-compact.js testdata/obf/seven/01-es5-basic.s1.obf.js -o /tmp/a.js
perl -e 'alarm 5; exec @ARGV' node /tmp/a.js < testdata/obf/seven/01-es5-basic.s1.obf.in
echo $?     # -> 142（SIGALRM。ハングしている）

# 保護モード: 整形され、かつ実行できる
node strip-code-compact.js testdata/obf/seven/01-es5-basic.s1.obf.js \
     -o /tmp/b.js --keep-self-defending
diff <(node testdata/src/01-es5-basic.js  < testdata/src/01-es5-basic.in) \
     <(node /tmp/b.js                     < testdata/src/01-es5-basic.in)   # -> 差分なし
```

`-o` を省いて stdout に出す場合だけ末尾に改行を 1 つ補う。
ファイルに書くときは補わないので、gold とのバイト比較は `-o` を使うこと。

開発が終わってから、JsDeObsBench の 7 変換を同時に掛けたデータに**チューニングなしで**掛けた。
