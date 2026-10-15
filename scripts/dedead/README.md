# strip-deadcode-injection — deadcode-injection だけを剥がす

javascript-obfuscator (obfuscator.io) で難読化されたスクリプトから、
**`deadcode-injection` の層だけ**を決定論的に取り除くスクリプト。

想定している入力は 7 変換を同時に掛けたスクリプト
（`string-obfuscation` / `name-obfuscation` / `deadcode-injection` /
`debug-protection` / `control-flow-flattening` / `code-compact` / `self-defending`）。
そのうち **`deadcode-injection` だけ**を解除し、残り 6 変換には一切触れない。

姉妹スクリプト `../destring/strip-string-obfuscation.js` の deadcode 版。

```bash
# 単一ファイル（-o を省くと stdout）
node strip-deadcode-injection.js input.obf.js -o output.js

# ディレクトリ一括
node strip-deadcode-injection.js --batch <indir> -o <outdir> \
     --ext .obf.js --suffix .dead.js --continue-on-error

# 何をどれだけ剥がしたか
node strip-deadcode-injection.js input.obf.js --stats -o /dev/null
# -> {"stringArrayPresent":true,"decoder":"_0x2ec7","decoderIssue":null,"storages":4,
#     "maxDelegationDepth":1,"candidates":16,"resolved":8,"removed":8,"unresolved":8,
#     "skippedShape":0,"skippedLeak":0,
#     "byPredicateForm":{"literal":0,"dictLiteral":2,"dictCall":6},
#     "shape":{"parentBlock":4,"ifOnly":4},"passes":2,"bytes":{"in":12607,"out":10867}}
```

初回のみ、リポジトリのルートで `npm install`（依存はルートの `package.json` にまとめてある）。

---

## 何を剥がすか

難読化器のソース (`BlockStatementDeadCodeInjectionNode.getNodeStructure`) で
生成形が 1 種類しかないことを確認してある:

```js
const isEq = random() > .5, isSame = random() > .5;
const op    = isEq ? '===' : '!==';
const left  = randomString(5);                 // pool は [a-zA-Z]
const right = isSame ? left : randomString(5);
const [cons, alt] = (isEq === isSame) ? [元のブロック, 死コード] : [死コード, 元のブロック];
return [ blockStatement([ ifStatement(binary(op, lit(left), lit(right)), cons, alt) ]) ];
```

つまり **元のブロックが `{ if('AbCdE' === 'FgHiJ') { 本物 } else { 死コード } }` に
丸ごと置き換わる**。4 通りを展開すると、真になる枝は必ず「元のブロック」側になる。

剥がすのは **偽になる枝と、それを選ぶための `if` と述語**だけ。

| 入力の形 | 出力 | 実測比率 (seven) |
|---|---|--:|
| `if` が親ブロックの唯一の文 → 親ブロックごと置換 | `{ if(P){A}else{B} }` → `{A}` | 269/460 |
| `if` が兄弟文を持つ → `if` だけ置換 | `var d={..};if(P){A}else{B}` → `var d={..};{A}` | 191/460 |

前者が難読化器の生成形の正確な逆変換。後者はブロックが 1 段余るが意味論は変わらない
（control-flow-flattening が同じブロックの先頭に storage 宣言を差し込むと兄弟文ができる）。

### 生きた枝のブロックは展開しない

1. 展開すると `let` / `const` / `class` が外側スコープへ出て再宣言衝突を起こしうる。
2. 難読化器は**関数本体の BlockStatement も置換対象にする**ので、
   `function f(){'use strict';..}` は `function f(){if(P){'use strict';..}else{..}}` に
   なり得る。この `'use strict'` はもう directive ではない。ブロックを外して
   関数本体の先頭へ戻すと **strict モードが復活して意味が変わる**。
   `testdata/src/13-strict-directive.js` がこの回帰テスト。

---

## 文字列は「読む」が「書き戻さない」

7 変換同時では述語が二重に間接化されていて、生のファイルに
「文字列リテラル同士の比較」は **1 つも現れない**（実測 0 件）。

```js
// 生ファイル
if(_0x52101a[_0x2ff2e1(0x223)](_0x2ff2e1(0x1f2),_0x52101a[_0x2ff2e1(0x1da)])){A}else{B}

// string 層を解いた姿
if(_0x52101a['PHazP']('odjtH',_0x52101a['CzTAH'])){A}else{B}
//   _0x52101a['PHazP'] => function(a,b){return _0x3f2479['NIrpW'](a,b);}
//   _0x3f2479['NIrpW'] => function(a,b){return a===b;}
//   _0x52101a['CzTAH'] => 'odjtH'                      → true → A が本物
```

検出のために `../destring` の部品を借りてデコーダを `node:vm` 上に組み立て、
control-flow-flattening の辞書も畳んで値を求める。
**求めた値は判定にしか使わない。出力の文字列表現は 1 バイトも変えない。**

辞書に入った比較関数は多段委譲する。本体が 1 文とは限らず、
`function(a,b){ const D=_0x1a07; return DICT[D(0x171)](a,b); }` のように
**デコーダ別名の宣言 + return** の 2 文になることがある（先頭の宣言は読み飛ばす）。

この経路があるおかげで、**生の 7 変換ファイルと、先に `destring` を掛けたファイルとで、
検出できる deadcode の件数が完全に一致する**（どちらも 460 件 / 45 サンプル）。

---

## 何を残すか

残り 6 変換には触れない。出力には次がそのまま残る:

- `string-obfuscation` の文字列配列（述語に使われていた 5 文字文字列が配列に残るのは正しい）
- `control-flow-flattening` の辞書オブジェクト
- `debug-protection` の検査ループ
- `self-defending` のラッパー
- `name-obfuscation` の 16 進識別子
- `code-compact`

### ★ CFF の辞書エントリは消さない

死枝でしか使われていないように見えるエントリでも消してはいけない。
難読化器は `usingExistingIdentifierChance = 0.5` で既存エントリを使い回すので、
同じエントリが生きたコードから参照されていることがある。
`verify.js` の `cffdict` チェックがこれを担保する。

### ★ 出力は 1 行のまま

整形して出力してはいけない。理由は 2 つある。

1. `code-compact` まで解除したことになり「deadcode-injection のみ解除」でなくなる。
2. **self-defending が発火する。** `fn.toString().search('(((.+)+)+)+$')` は
   改行が入った途端に catastrophic backtracking を起こし事実上ハングする。

---

## 失敗するとき — 姉妹スクリプトと方針が違う

`destring` は畳み込みに失敗すると壊れたコードが出るので「確信が持てなければ非ゼロ終了」。
このスクリプトは**死枝を残しても出力は正しく動く**（剥がし残しになるだけ）ので、
**確信が持てない `if` は触らずに続行する**。数は `--stats` に出る。

| 状況 | ふるまい | stats |
|---|---|---|
| 述語を解決できない | その `if` を残して続行 | `unresolved` |
| 難読化器が作る形（1 文だけのブロック）でない | その `if` を残して続行 | `skippedShape` |
| 死枝の `var` / `function` が枝の外から参照されている | その `if` を残して続行 | `skippedLeak` |
| 文字列配列はあるがデコーダを組み立てられない | デコーダ無しで続行 | `decoderIssue` |
| 生成したコードがパースできない | **非ゼロ終了** | — |
| 自己検査（部分列性・ノード会計）が破れた | **非ゼロ終了** | — |
| `--require-all` 指定時に未解決が残った | **非ゼロ終了** | — |

`deadcode-injection` が掛かっていない入力は、**入力をそのまま出力**して正常終了する
（冪等。同じファイルに 2 回掛けても 1 バイトも変わらない）。

### 何度か回す

1 パスでは取りこぼすことがある。死枝を消したことで「枝の外からの参照」が消え、
前のパスで安全弁 (`skippedLeak`) に引っかかった `if` が次のパスでは剥がせるようになる。
変化が無くなるまで回すので、`--stats` の `passes` が 2 以上になることがある（実測で最大 3）。

### 対応していない設定

| 設定 | 何が起きるか |
|---|---|
| `stringArrayCallsTransform` / `stringArrayEncoding: ["base64","rc4"]` + 関数ラッパー | デコーダを組み立てられず述語が読めない（`configs/hard.json`） |
| `transformObjectKeys: true` | 辞書が `var s={}; s['a']=..` になり引けない（`configs/objkeys.json`） |
| `simplify: true` | `if` が三項に畳まれて「両枝 BlockStatement」の前提が崩れる |

いずれも**剥がし残すだけ**で、壊れたコードは出さない。`verify.js` の `degrade` チェックで担保。

---

## 誤検出を避ける仕掛け

利用者コードにも `if('alpha' === 'bravo'){..}else{..}` のような 5 文字定数比較はあり得る。
畳んでも意味論は保たれるが、「deadcode-injection の層だけを剥がした」とは言えなくなる。
そこで 3 つの条件を全部満たすものだけを対象にする。

1. 述語が **5 文字の英大小文字**同士の `===` / `!==` に畳める（難読化器の仕様上の保証）
2. `consequent` と `alternate` が**両方とも BlockStatement**
3. `if` が親ブロックの**最後の文**で、それ以前は全部変数宣言（難読化器が作る形）

加えて、述語を読むときは**素の変数を束縛経由で辿らない**。
難読化器は述語の値をリテラル・デコーダ呼び出し・辞書参照でしか書かないので、
`const A='alpha', B='bravo'; if(A===B){..}else{..}` を deadcode と誤認しなくなる。
`testdata/src/14-dead-predicate-trap.js` がこの負例。

`--no-strict-shape` で条件 3 を外せる。

---

## `../destring` との関係

`../destring/strip-string-obfuscation.js` から次の 4 つだけを借りている。
いずれも**プレーンな AST ノードを取って値を返す**関数:

`matchStringArrayFunction` / `matchDecoderFunction` / `matchRotatorStatement` /
`buildDecoder` / `literalArgValue`

★ 開発時はスクリプトごとに `node_modules` が別実体だったので、**境界を越えてよいのは AST ノードと値だけ**という設計にしてある（いまはルートの `node_modules` を共有している）。
`NodePath` / `Scope` / `traverse` は必ず自分側の `@babel` で扱う
（別名の不動点収集もこちら側でやっている）。`destring` 側は一切変更していない。

### 掛ける順序

どちらの順でも成功する（45/45 で例外なし）が、**`destring` → `dedead` を推奨**する。

```bash
node ../destring/strip-string-obfuscation.js A.obf.js -o /tmp/a1.js
node strip-deadcode-injection.js /tmp/a1.js -o /tmp/a2.js
```

逆順だと、デコーダ別名の宣言 (`const D=_0x1a07;`) が `if` の兄弟文として残っているせいで
「親ブロックごと置換」が使えず、ブロックが 1 段余る
（`function(){{return![];}}` と `function(){return![];}`）。意味は同じ。

---

## 検証

**ベンチマークのデータセットは開発にも検証にも使っていない。**
特定のデータへの過適合を避けるため、検証コーパスはすべてここで新しく生成する。

```bash
node gen-corpus.js   # testdata/src/*.js を難読化して testdata/obf/ を作る
node verify.js       # 全サンプルを検査（設定名を渡すとその設定だけ）
```

`gen-corpus.js` は生成後に**実際に死コードが入ったか**を数えて表にする。
`deadCodeInjection` は収集できるブロックが 5 個未満だと何も入れないので、
「そもそも入っていないサンプルで PASS した」を成功と誤認しないため。

### 検査項目

| 項目 | 内容 |
|---|---|
| `strip` | deadcode を検出して除去できた |
| `accounting` | `candidates = resolved + unresolved + skippedShape + skippedLeak`、`removed = resolved = parentBlock + ifOnly` |
| `parse` | 出力が JS としてパースできる |
| `stable` | `generate(parse(out)) === out` |
| `subseq` | **出力が入力の文字単位の部分列** = 1 文字も足さず削除しかしていない |
| `layers` | **全ノード種別**で `入力 − 除去分 = 出力` = 除去部分木以外はノード 1 つ動いていない |
| `certificate` | スクリプトの申告を使わず、入出力 AST を並行再帰比較して除去件数を独立に数え直す |
| `strarray` | 文字列配列の要素が入力と要素単位で一致（string 層が無傷） |
| `cffdict` | 出力に残る CFF 辞書がキーも値も入力と一致 |
| `marks` | debug-protection / self-defending の目印が残っている |
| `compact` | 入力が 1 行なら出力も 1 行 |
| `residue` | もう一度掛けると検出 0 件 |
| `idem` | 2 回目の適用で 1 バイトも変わらない |
| `behave` | 原本・難読化後・解除後の 3 つが同じ stdout / 終了コードを返す |
| `passthrough` | 除去 0 件のときは入力をそのまま返している |

`layers` は `destring` の同名検査（20 種の固定リストに限定）より強い。
このスクリプトは畳み込みもリネームも整形もしないので、**全ノード種別**で等式が成立する。

### 対照群

- 難読化していない `testdata/src/*.js` を入れても 1 バイトも変えないこと
- `configs/string-only.json`（deadcode なし）で検出 0 件・出力不変であること
- `configs/hard.json` / `configs/objkeys.json`（述語が読めない負例）で、
  例外を投げず・壊れたコードを出さず・剥がし残したまま正常終了すること

### 検証結果（225 サンプル / 全項目 PASS）

| 設定 | サンプル | 発火 | 候補 | 除去 | 未解決 | 親ブロック置換 | if のみ置換 | literal/dictLiteral/dictCall | 最大パス |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| seven | 45 | 45 | 952 | 460 | 480 | 269 | 191 | 0/104/356 | 2 |
| destr-seven | 45 | 45 | 862 | 460 | 390 | 361 | 99 | 10/94/356 | 2 |
| dead-max | 30 | 8 | 120 | 52 | 59 | 52 | 0 | 42/10/0 | 3 |
| dead-cff | 15 | 4 | 59 | 26 | 29 | 26 | 0 | 0/0/26 | 2 |
| deadcode-only | 15 | 4 | 46 | 13 | 29 | 13 | 0 | 1/12/0 | 2 |
| destr-dead-max | 30 | 8 | 81 | 52 | 20 | 52 | 0 | 52/0/0 | 3 |
| string-only | 15 | 0 | 22 | **0** | 20 | 0 | 0 | 0/0/0 | 1 |
| objkeys | 15 | 15 | 340 | 132 | 194 | 84 | 48 | 0/36/96 | 2 |
| hard | 15 | 0 | 280 | **0** | 280 | 0 | 0 | 0/0/0 | 1 |

- `seven` と `destr-seven` の除去件数が **460 で一致** = string 層の有無で結果が変わらない
- `string-only`（deadcode なし）で除去 0 件 = 誤検出なし
- 「未解決」の大半は利用者コードや難読化器ヘルパの本物の `if`。
  `DEDEAD_DEBUG=1` を付けると未解決の述語が stderr に並ぶ

### コーパス

`testdata/src/*.js` — `../destring` と共通の 12 本に、このスクリプト用の 3 本を足した 15 本。

| 追加 | 狙い |
|---|---|
| `13-strict-directive.js` | 関数本体先頭の `'use strict'`。ブロックを外すと strict が復活する罠の回帰テスト |
| `14-dead-predicate-trap.js` | 利用者コードの 5 文字定数比較。誤検出しないことの負例 |
| `15-many-small-blocks.js` | 小ブロックを多数（switch / for / try-catch / class メソッド / getter）。注入密度を上げる |
