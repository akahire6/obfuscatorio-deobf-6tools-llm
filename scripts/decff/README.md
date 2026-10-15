# strip-control-flow-flattening — control-flow-flattening だけを剥がす

javascript-obfuscator (obfuscator.io) で難読化されたスクリプトから、
**`control-flow-flattening` の層だけ**を決定論的に取り除くスクリプト。

想定している入力は 7 変換を同時に掛けたスクリプト
（`string-obfuscation` / `name-obfuscation` / `deadcode-injection` /
`debug-protection` / `control-flow-flattening` / `code-compact` / `self-defending`）。
そのうち **`control-flow-flattening` だけ**を解除し、残り 6 変換には一切触れない。
姉妹スクリプト `../destring/strip-string-obfuscation.js` の CFF 版で、
[`deobfuscate.js`](../../deobfuscate.js) が掛ける 6 段のうち 3 段目。

```bash
# 単一ファイル（-o を省くと stdout）
node strip-control-flow-flattening.js input.obf.js -o output.js

# ディレクトリ一括
node strip-control-flow-flattening.js --batch <indir> -o <outdir> \
     --ext .obf.js --suffix .decff.js --continue-on-error

# 何をどれだけ剥がしたか
node strip-control-flow-flattening.js input.obf.js --stats -o /dev/null
```

初回のみ、リポジトリのルートで `npm install`（依存はルートの `package.json` にまとめてある）。

---

## 何を剥がすか

`controlFlowFlattening` は **2 種類のコード**を生む。両方を剥がす。

### (a) control flow storage 辞書（多数派。実データの全問に出る）

二項演算・呼び出し・文字列定数を、辞書オブジェクト経由の間接参照に置き換えたもの。

```js
// before
var S = {'ENUXx':function(a,b){return a(b);},     // 呼び出しの間接化
         'MHoSl':function(a,b){return a+b;},       // 二項演算の間接化
         'DySfa':'RNVKk',                          // 文字列定数の間接化
         'MjWLl':OTHER['LcEku']};                  // 別辞書への委譲
S['MHoSl'](x, y)

// after
x + y
```

### (b) switch ディスパッチャ

5 文以上のブロックを、順序文字列 + `while` + `switch` に平坦化したもの。

```js
// before
var ORD = S['wJRmM']['split']('|');   // ← 順序文字列は storage の中にいる
var IDX = 0;
while (!![]) { switch (ORD[IDX++]) { case '0': A; continue; case '1': B; continue; } break; }

// after
B; A;     // 元の文順に戻して、親ブロックへ直接展開する
```

**★ (a) を先に畳まないと (b) の順序文字列が読めない。** 順序文字列は storage の
プロパティに入っていて、しかもそのキーが文字列配列のデコーダ呼び出しで書かれている。
自前コーパスで測ると、storage を先に畳まなければ順序が読めるのは 69 個中 42 個だけだった。

**★ 展開はブロックで包まず、親ブロックへ直接並べる。** ケース本体の `var` は
他のケースから参照される（巻き上げ依存）。平坦化は「親ブロックの文の並びを
置き換えた」だけなので、逆変換も「3 文を n 文に戻す」で足りる。

## 何を残すか

残り 6 変換には触れない。出力には次がそのまま残る:

- `string-obfuscation` の文字列配列・デコーダ・ローテータ（**1 バイトも変えない**。
  storage のキーだった要素が配列に残って到達不能な余りになるのが正しい。
  抜くとローテータの検査和が壊れる）
- `deadcode-injection` のダミー分岐（`S['K']('wwyYH', S['L'])` を畳むと
  `'wwyYH'==='wwyYH'` になるが、**定数畳み込みはしない**ので `if` 文は残る）
- `debug-protection` の検査ループ
- `self-defending` のラッパー
- `name-obfuscation` の 16 進識別子
- `code-compact`（後述）

### ★ 文字列は「読む」が「書き戻さない」

生の 7 変換入力では、storage のキー参照が `S[dec(0x1b8)]` の形になる
（自前コーパスで 2778 件中 2080 件）。キーを読むために `../destring` の部品を借りて
デコーダを `node:vm` 上に組み立てるが、**復号した文字列は出力に一切出さない**。
検証の `str-nonew` が「出力に新しい文字列リテラルが 1 つも現れないこと」を機械的に見ている。

### ★ 出力は 1 行のまま

整形して出力してはいけない。理由は 2 つある。

1. `code-compact` まで解除したことになり「control-flow-flattening のみ解除」でなくなる。
2. **self-defending が発火する。** `fn.toString().search('(((.+)+)+)+$')` で整形を検出する
   仕掛けで、改行が入った途端に catastrophic backtracking を起こし事実上ハングする。
   CFF は self-defending の内側も書き換えるので、この保護はいっそう重要。

---

## 畳んでよいと言い切るための条件

storage 辞書と判定するには次を**全部**満たす必要がある。

1. `var X = { ... }` の形で、プロパティが 1 つ以上ある
2. 文字列層の 3 部品（配列関数・デコーダ・ローテータ）の内側ではない
3. 全プロパティが非 computed で、キーが文字列リテラル
4. 全キーが `/^[A-Za-z]{5}$/`、重複なし
5. 「難読化器が作った」印が 1 つ以上ある（転送関数、またはデコーダ呼び出し）
6. 全ての値が 転送関数 / 文字列・数値リテラル / デコーダ呼び出し / 別辞書への委譲 のいずれか
7. 再代入されていない
8. 全参照が `X[<読めるキー>]` の形（辞書そのものを渡す・`Object.keys`・動的キーがあれば不採用）

転送関数（インライン展開してよい関数）の条件:

- `function (a, b) { return <式>; }` の形（先頭に復号器別名の再束縛があるのは許す）
- **各パラメータがちょうど 1 回・宣言順に現れる**
- 式が `a OP b` / `a(b, ...)` / `OTHER['K'](a, b, ...)` のいずれか

この「ちょうど 1 回・宣言順」が、副作用のある実引数を埋めても評価回数と評価順序が
変わらないことの根拠になる。自前コーパスの 2429 プロパティは全部これを満たしていたが、
満たさない形を黙って畳むと壊れるので判定は必ず行う。

展開しないもの:

- 引数の個数がパラメータ数と違う / `SpreadElement` がある（評価回数が変わる）
- **`S['call'](obj.m, x)` → `obj.m(x)`**（`this` が `undefined` から `obj` に変わる）
- 関数値が呼び出しの callee 以外の位置で参照されている
- 委譲先が解決できない（デッドコードに紛れ込んだコピー。展開せず残すのが安全）

### ★ 「ブロックの先頭にあること」は条件に入れていない

最初は入れていたが外した。自前コーパスで測ると、位置を見ても見なくても、
難読化していない実コード 19 本の判定は同じだった（どちらも誤検出ゼロ）。
一方で、自分が storage を消したりディスパッチャを展開したりすると後続の文が繰り上がって
判定が変わり、畳み残しと「2 回掛けると結果が変わる」を引き起こす。
守れていないものを守るために壊れるので、入れない。

### 既知の限界

5 文字キーだけを持ち、全プロパティが転送関数か難読化器由来の定数で、定数キーでしか
参照されないオブジェクトは、ユーザーが書いたものでも CFF の storage と**構造上
区別できない**。そういうオブジェクトは畳まれる（挙動は変わらない）。
`testdata/src/20-cff-decoy-objects.js` は、現実のコードにありがちな形で
条件のどれかを外した負例を並べてある。

## 失敗するとき

確信が持てない状況では**出力せず非ゼロ終了する**。黙って壊れたコードを出さない。

- 入力がパースできない
- 文字列配列関数はあるがデコーダ関数が見つからない（未対応設定）
- デコーダの `vm` 評価が失敗した / タイムアウトした
- 解除後も畳めるはずの storage が残っている（`--strict` 時）
- 生成したコードがパースできない
- **入力が 1 行なのに出力に改行が入った**
- 不動点が収束しない / 委譲が 16 段を超えた

`control-flow-flattening` が掛かっていない入力は、**入力をそのまま出力**して正常終了する
（冪等。同じファイルに 2 回掛けても変わらない）。

### 対応していない設定

`stringArrayWrappersType: "function"` / `stringArrayCallsTransform: true` /
`stringArrayEncoding: ["base64","rc4"]` の組み合わせ（`configs/cff-hard.json`）は
文字列層のデコーダを組み立てられないので **storage のキーが読めない**。
安全弁が働いて失敗するか、何も検出せず素通しする。壊れたコードが出ることはない。

他に `transformObjectKeys` / `simplify` / `numbersToExpressions` は未対応。

---

## 収束のさせ方

`parse → 変換 → generate` を、**出力テキストが変わらなくなるまで**回している
（最大 8 周。実測では 2〜3 周で止まる）。

在メモリの AST を書き換え続けると、Babel のスコープ情報が実際の木とわずかにずれて
「本当は参照 0 なのに除去されない」が起きる。生成し直して読み直せばその曖昧さが消える。
これで「2 回掛けても 1 バイトも変わらない」が構造的に保証される。

なお `scope.crawl()` は `Binding` オブジェクトを作り直すので、
別名や storage の識別は**必ず `binding.path.node`（宣言ノード）の同一性**で行っている。
`Set<Binding>` を crawl を跨いで持ち回ると判定が全部 false になる。

---

## 検証

**ベンチマークのデータセットは開発にも検証にも使っていない。**
特定のデータへの過適合を避けるため、検証コーパスはすべてここで新しく生成する。

```bash
node gen-corpus.js   # testdata/src/*.js を難読化して testdata/obf/ を作る
node verify.js       # 全サンプルを検査
```

- `testdata/src/01〜12` — `../destring` と共通の 12 本（storage 辞書の検証に十分）
- `testdata/src/13〜20` — **CFF 用に書き下ろした 8 本**。基本 / 入れ子 / `var` 巻き上げ /
  `return`・`throw` 終端 / ユーザーの `break`・`continue` / 引数の副作用と評価順序 /
  `this` バインディング / 誤検出の負例
- `configs/seven.json` を 5 シード、`cff-only.json` を 3 シード、
  `no-cff.json` と `cff-hard.json` を 1 シードで難読化

### ★ 新しいソースが ES5 スタイルなのは必須条件

`../destring` の 12 本は **switch ディスパッチャを 1 つも出さない**。
obfuscator.io の `canTransformBlockStatementNode` が

- ブロック直下が 5 文未満
- 部分木に `FunctionDeclaration` / `break` / `continue` / `let` / `const` / `class` がある
  （ただし `while` の内側は見ない）

のいずれかで対象外にするため、ES6 スタイルのコードは全ブロックが弾かれる。
ソースの大きさの問題ではない。13〜20 を `var` だけで書いたのはこのため。

`verify.js` がサンプルごとに見るもの:

| 項目 | 内容 |
|---|---|
| `strip` | CFF を検出して解除できた |
| `parse` | 出力が JS としてパースできる |
| `ledger` | **全ノード種別で 入力 − 除去 + 追加 = 出力**（台帳に無い改変がゼロ） |
| `frozen` | CFF で動くはずのない 22 種が 1 つも増減していない |
| `str-array` | 文字列配列の中身が入出力でバイト一致（順序含む） |
| `str-parts` | 配列関数・デコーダ・ローテータの生成コードがバイト一致 |
| `str-nonew` | 出力に新しい文字列が 1 つも現れない |
| `names` | 出力に新しい識別子名が 1 つも現れない |
| `cff-gone` | storage もディスパッチャも残っていない |
| `compact` | 入力が 1 行なら出力も 1 行 |
| `residue` / `idem` | もう一度掛けると「対象なし」になり、1 バイトも変わらない |
| `marks` | self-defending / debug-protection の目印が残っている |
| `behave` | 原本・難読化後・解除後の 3 つが同じ stdout と終了コードを返す |

`ledger` と `frozen` が「他 6 変換を触っていない」ことの機械的な証明になっている。
とくに **`IfStatement` が 0 差分であることが `deadcode-injection` 層の保存の直接証明**。
`str-nonew` が「文字列層を読んだだけで書き戻していない」ことの、
`names` が「識別子を作っていない」ことの証明。

`cff-gone` は「デッドコードに紛れ込んだ、委譲先が束縛されていないコピー」は数に入れない。
委譲先が解決できない以上畳みようがなく、展開せず残すのが挙動保存的に正しいため。

現状の結果:

```
seven (100 サンプル)       100/100 PASS   ← ディスパッチャ 61 個を含む
cff-only (51 サンプル)      51/51  PASS
no-cff（CFF 無し・負例）    20/20  PASS   ← 1 バイトも変えないこと
cff-hard（対象外設定）      20/20  PASS   ← 壊れたコードを出さないこと
非対象入力                  20/20  PASS   ← 難読化していないコードを壊さないこと
```

seven 100 件での解除量:

| | 合計 |
|---|---:|
| storage 辞書の除去 | 908 |
| 定数の畳み込み | 3,690 |
| 呼び出しの畳み込み | 3,914 |
| switch ディスパッチャの展開 | 61 |
| 文字数の削減率（中央値） | **46.2%** |

開発が終わってから、JsDeObsBench の 7 変換を同時に掛けたデータに**チューニングなしで**掛けた。
