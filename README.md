# obfuscatorio-deobf-6tools-llm

javascript-obfuscator（obfuscator.io）の **7 変換を同時に掛けた難読化**を、
**決定論ツール 6 本 + LLM 1 回**で解除する。

## Overview (English)

This repository deobfuscates JavaScript produced by
[javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator) (obfuscator.io)
with seven transformations applied at once: string array, dead-code injection,
control-flow flattening, self-defending, debug protection, compact output and hexadecimal identifier renaming.
This is the same setting as `combinations/C77-0` in the [JsDeObsBench](https://github.com/Ch3nYe/JsDeObsBench)
benchmark (CCS'25).

- Six deterministic Node.js tools (`tools/`) strip six layers, one layer each, with Babel/acorn AST transforms.
  No LLM is involved at run time, it takes about 0.6 s per file, and the output preserves behaviour.
  The tools themselves were written with an LLM (Claude Code).
- Identifier names (`_0x1a2b3c`) cannot be recovered by AST rewriting, so the result goes to an LLM once,
  using the unmodified zero-shot prompt from JsDeObsBench (`prompts/zeroshot.txt`).
  A regular chat UI is enough: paste the generated prompt and copy back the code block.

On 200 C77-0 problems from JsDeObsBench (Claude Opus 5, one-shot prompt), the result was **exec 100%, overall 88.55**,
compared with 87.02 for the LLM alone and 85.84 for webcrack (88.04 with the zero-shot prompt). Full numbers are below (in Japanese).

```bash
npm install
node deobfuscate.js input.obf.js -o input.tools.js --prompt input.prompt.txt
# then paste input.prompt.txt into a chat (one file per new conversation)
```

> **Safety:** the tools evaluate the string-array decoder extracted from the input inside `node:vm`,
> which is **not** a security sandbox. Run untrusted or malicious samples only inside a disposable container or VM.

---

## これは何か

```
難読化コード（7 変換）
  │ 1  tools/destring       string-obfuscation       文字列配列・デコーダ・ローテータを畳み込む
  │ 2  tools/dedead         deadcode-injection       不透明述語のダミー分岐を消す
  │ 3  tools/decff          control-flow-flattening  辞書オブジェクトと switch ディスパッチャを元に戻す
  │ 4  tools/deselfdefend   self-defending           整形を検出してハングさせる罠を外す
  │ 5  tools/dedebug        debug-protection         debugger の検査ループを外す
  │ 6  tools/decompact      code-compact             整形する
  ▼
識別子名だけが _0x1a2b3c のまま残ったコード      ← ここまで LLM なし・1 問約 0.6 秒・$0
  │ LLM に 1 回（prompts/zeroshot.txt。チャットに貼るだけ）
  ▼
解除済みコード
```

7 変換のうち `name-obfuscation`（識別子を `_0x1a2b3c` に置き換える）だけは、元の名前の情報が
難読化の時点で失われている。AST をどう操作しても戻らないので、ここだけを LLM に任せる。
残り 6 層は機械的な変換なので、決定論ツールのほうが確実である。
LLM に 7 層まとめて解かせると、200 問中 10〜19 問が原本と同じ出力を返さなかった（下の表の exec 95.0% / 90.5%）。
30 問で 1 層ずつ剥がさせた実験でも、制御フロー平坦化（control-flow-flattening）の段は 27 回中 13 回、
入力を 1 バイトも変えずに返した。一方、6 本のツールは 200 問中 193 問で 6 層すべてを剥がし、
200 問すべてで原本と同じ挙動を保った。

6 本のスクリプトは LLM（Claude Code）を使って 1 層に 1 本ずつ作成した。実行時には LLM を使わない。

対象の 7 変換と設定は JsDeObsBench の `combinations/C77-0` と同じ
（[`examples/c77-0.json`](examples/c77-0.json) に同じ効果の設定を置いた）。

## 結果

JsDeObsBench の `combinations/C77-0` から seed=42 で抽出した **200 問**
（[`reproduce/subset_n200.json`](reproduce/subset_n200.json)）。LLM は Claude Opus 5（`claude-opus-5`）。
採点は JsDeObsBench の評価器を改変せずに使った。単位は %。

| 条件 | プロンプト | syntax | exec | decomplexity | similarity | overall |
|---|---|---:|---:|---:|---:|---:|
| **6 ツール + LLM（このリポジトリ）** | oneshot | 100.00 | **100.00** | 93.54 | **60.64** | **88.55** |
| **6 ツール + LLM（このリポジトリ）** | zeroshot | 100.00 | **100.00** | 93.55 | 58.61 | 88.04 |
| LLM のみ（難読化コードをそのまま 1 回） | oneshot | 100.00 | 95.00 | 93.55 | 59.54 | 87.02 |
| LLM のみ（難読化コードをそのまま 1 回） | zeroshot | 99.50 | 90.50 | 92.72 | 56.86 | 84.89 |
| 6 ツールのみ（LLM なし） | — | 100.00 | **100.00** | 93.33 | 38.57 | 82.98 |
| [webcrack](https://github.com/j4k0xb/webcrack) | — | 100.00 | **100.00** | 92.33 | 51.04 | 85.84 |
| [synchrony](https://github.com/relative/synchrony) | — | 100.00 | 0.50 | 79.06 | 38.09 | 54.41 |
| [js-deobfuscator](https://github.com/ben-sb/javascript-deobfuscator) | — | 100.00 | 0.50 | 1.48 | 28.19 | 32.54 |

- **syntax**: 構文として正しい割合。**exec**: テストケースで原本と同じ出力を返す割合。
  **decomplexity**: Halstead 長が難読化コードから減った割合。**similarity**: 原本との CodeBLEU。
  **overall**: 4 指標の単純平均。定義はすべて JsDeObsBench と同じ。
- 「6 ツール + LLM」と「LLM のみ」の差は、exec が +5.0pt（McNemar p=0.002）、
  similarity が +1.1pt（Wilcoxon p<0.001）。いずれも oneshot での比較。
- 「6 ツールのみ」と「6 ツール + LLM」の差（similarity 約 22pt）が、識別子名を戻した分にあたる。
- oneshot は例を 1 つ見せるプロンプト。例文は上流のデータから作るので、このリポジトリには含めていない
  （作り方は [`prompts/README.md`](prompts/README.md)）。チャットで使うなら zeroshot で十分。

### チャットで使った場合

実験では LLM を Claude Code の CLI（`claude -p`）経由で呼んだ。この呼び方では、約 2.7 万トークンの
Claude Code の既定システムプロンプトと、出力の形だけを指定する
[`prompts/system_benchmark.txt`](prompts/system_benchmark.txt) が前に付く。
チャットにプロンプトを貼るだけの使い方でも同じ結果が出るかを、同じ 30 問
（[`reproduce/subset_n30.json`](reproduce/subset_n30.json)）で確かめた。
「チャット相当」は、CLI でシステムプロンプトを空に指定し、ツールを外して 1 回だけ答えさせた条件である
（CLI の仕様で約 800 トークンの前置きは残る）。

| 条件（zeroshot、n=30） | syntax | exec | decomplexity | similarity | overall |
|---|---:|---:|---:|---:|---:|
| 実験の呼び方（1 回目） | 100.00 | 100.00 | 94.11 | 59.77 | 88.47 |
| 実験の呼び方（2 回目） | 100.00 | 100.00 | 94.11 | 61.32 | 88.86 |
| **チャット相当** | 100.00 | **100.00** | 94.09 | 58.21 | **88.08** |

- **exec 100% はチャットでもそのまま再現した**。挙動を守っているのは前段のツールである。
- similarity は 1.6〜3.1pt 低い。同じ呼び方の 1 回目と 2 回目でも 1.6pt 動くので、ばらつきとの区別は
  つきにくいが、30 問中 17〜18 問で下回ったので、少し下がる傾向はあると見てよい。
  出力を読むと、チャット相当のほうが名前以外も書き換えやすい（`~~x` → `Math.trunc(x)`、
  `some` → `forEach`、中間変数の追加、コメントの追加など）。挙動は変わらないが、原本との字面の一致は下がる。
- 検証したのは Claude Opus 5 だけ。チャットの画面ごとにシステムプロンプトは異なり、他社のモデルも試していない。

## 必要なもの

- Node.js 18 以上（v18.19.0 と v26.8.2 で、200 問の出力がバイト単位で一致することを確認した）
- 識別子名を戻すための LLM（チャットでよい）

## 使い方

### 1. インストール

```bash
git clone https://github.com/akahire6/obfuscatorio-deobf-6tools-llm.git
cd obfuscatorio-deobf-6tools-llm
npm install
```

### 2. ツールで 6 層を剥がす

```bash
node deobfuscate.js input.obf.js -o input.tools.js --prompt input.prompt.txt
```

```
  [1/6] string-obfuscation          9636 →    6631 文字
  [2/6] deadcode-injection          6631 →    5062 文字
  [3/6] control-flow-flattening     5062 →    2610 文字
  [4/6] self-defending              2610 →    2027 文字
  [5/6] debug-protection            2027 →     874 文字
  [6/6] code-compact                 874 →    1379 文字
9636 → 1379 文字（-85.69%）
```

- `input.tools.js` は、識別子名以外を解除したコード。
- `input.prompt.txt` は [`prompts/zeroshot.txt`](prompts/zeroshot.txt) の `{obfuscated_code}` に
  `input.tools.js` を埋め込んだもの。
- ディレクトリをまとめて処理するときは `--batch <indir> -o <outdir> --prompt <promptdir>`。
- 各段の中間コードと記録（`pipeline.json`）を残すときは `--work-dir <dir>`。
- ツールが剥がせないと判断した段は、壊れたコードを出さずに非ゼロ終了する。
  `deobfuscate.js` はその段を飛ばし、前段のコードを次の段に渡す。
  `self-defending` が剥がせなかったときは、罠が発火しないよう最後の整形（`code-compact`）も掛けない。
  このとき終了コードは 3 になる（出力は書かれる）。

### 3. LLM に識別子名を戻させる（チャット）

1. チャットで**新しい会話**を開く（1 ファイルにつき 1 会話）。
2. `input.prompt.txt` の中身をすべて貼り付けて送る。プロンプトは英語のまま変えない。
3. 返ってきた**最初のコードブロックの中身**が最終結果になる。

### 3'. 多数のファイルを CLI でまとめて処理する（任意）

[Claude Code](https://claude.com/claude-code) が入っていれば、プロンプトのディレクトリを一括で投げられる。

```bash
node reproduce/ask-claude.js <promptdir> <outdir> --mode chat          # 上の「チャット相当」
node reproduce/ask-claude.js <promptdir> <outdir> --mode experiment    # 実験と同じ呼び方
```

`<outdir>/<name>.deobf.js` に最初のコードブロックを書く（抽出規則は JsDeObsBench と同じ正規表現）。
チャット相当では 30 問で約 $1 だった（CLI が報告した額）。

## 例

[`examples/`](examples/) に、自作の小さなプログラムで 1 周した結果を置いた。

| ファイル | 中身 | 文字数 |
|---|---|---:|
| [`sample.js`](examples/sample.js) | 原本 | 883 |
| [`sample.obf.js`](examples/sample.obf.js) | [`c77-0.json`](examples/c77-0.json) で難読化（seed=1） | 9,636 |
| [`sample.tools.js`](examples/sample.tools.js) | 6 ツールの出力（識別子名以外は解除済み） | 1,379 |
| [`sample.prompt.txt`](examples/sample.prompt.txt) | チャットに貼るプロンプト | — |
| [`sample.llm.js`](examples/sample.llm.js) | チャット相当で LLM が返したコード | — |

4 つの `.js` はどれも同じ出力を返す（`node examples/sample.llm.js`）。6 ツールの出力では局所変数名が
`_0x399358` のまま残っているが、LLM を通すと戻る。

```js
// sample.tools.js（6 ツールの出力）
function average(_0x399358) {
    let _0x2a13eb = 0x0;
    for (const _0x2531b4 of _0x399358) {
        _0x2a13eb += _0x2531b4;
    }
    return _0x2a13eb / _0x399358['length'];
}

// sample.llm.js（LLM の出力）
function average(scores) {
  let sum = 0;
  for (const score of scores) {
    sum += score;
  }
  return sum / scores.length;
}
```

難読化をやり直すときは `npx javascript-obfuscator examples/sample.js --config examples/c77-0.json --seed 1 --output out.js`。

## JsDeObsBench で数値を再現する

```bash
# 0) 上流のベンチマーク（データと評価器）。評価器の準備（Python の依存・Docker・escomplex）は上流の README に従う
git clone https://github.com/Ch3nYe/JsDeObsBench.git
git -C JsDeObsBench checkout 8b2e1c35dc4ae25a46ea580ea5dcb6b5de5edbe9   # 測定に使ったコミット
D=JsDeObsBench/build_dataset/codenet_dataset_combinations/C77-0/Project_CodeNet_selected.jsonl
SUBSET=reproduce/subset_n200.json    # 30 問なら reproduce/subset_n30.json

# 1) 問題を 1 問 1 ファイルに取り出す
node reproduce/jsdeobsbench.js extract $D $SUBSET work/obf

# 2) 6 ツール（出力は測定時とバイト単位で一致するはず。下の sha256 で確認できる）
node deobfuscate.js --batch work/obf --ext .obf.js -o work/tools --suffix .tools.js --prompt work/prompts
(cd work/tools && shasum -a 256 -q --ignore-missing -c ../../reproduce/expected/tools_n200.sha256 && echo 全件一致)

# 3) LLM。チャットに 1 問ずつ貼って work/llm/<name>.deobf.js に保存するか、CLI でまとめて処理する
node reproduce/ask-claude.js work/prompts work/llm --mode chat
#    実験と同じ条件（oneshot・実験の呼び方）にするなら、2) と 3) を次に替える
#    node reproduce/jsdeobsbench.js example JsDeObsBench/deobfuscators/examples.json > work/example.txt
#    node deobfuscate.js --batch work/obf --ext .obf.js -o work/tools --suffix .tools.js \
#         --prompt work/prompts-oneshot --template prompts/oneshot.txt --example work/example.txt
#    node reproduce/ask-claude.js work/prompts-oneshot work/llm --mode experiment

# 4) 上流の評価器が読む形にまとめて採点する（Docker が必要）
node reproduce/jsdeobsbench.js pack $D $SUBSET work/llm "$PWD/work/results/hybrid.jsonl"
node reproduce/jsdeobsbench.js pack $D $SUBSET work/tools "$PWD/work/results/tools-only.jsonl" --suffix .tools.js
(cd JsDeObsBench && python eval.py --results "$OLDPWD/work/results/hybrid.jsonl" --contrainer_name eval_hybrid)
node reproduce/score.js work/results/hybrid.metrics.jsonl
```

- `eval.py` のオプション名 `--contrainer_name` の綴りは上流のまま（スペルは誤りだが、こう書かないと動かない）。
- 2) で書き出すプロンプトは、zeroshot・oneshot とも測定時に LLM へ送ったものとバイト単位で一致する（30 問で確認）。
- 200 問のうち 7 問（`p02388_1` `p02408_1` `p03202_1` `p03273_1` `p03624_1` `p03943_1` `p03948_1`）は
  `self-defending` を剥がせず、終了コード 3 で終わる。測定時も同じだった。
- LLM の出力は毎回変わる。同じ 30 問を同じ呼び方で 2 回解かせると、similarity が 1.6pt 違った。
  CodeBLEU のデータフロー成分も非決定的で、同じ出力を採点し直すだけで平均が動く
  （上の表の「6 ツールのみ」は、同じ出力を 2 回採点して 38.57 と 38.35 になった）。

## 6 本のツール

| ツール | 剥がす層 | やり方 |
|---|---|---|
| [`destring`](tools/destring/) | string-obfuscation | 文字列配列・デコーダ・ローテータの 3 部品だけを `node:vm` で実行し、呼び出しを実リテラルに畳み込んでから部品ごと消す。デコーダの中身は読み解かない |
| [`dedead`](tools/dedead/) | deadcode-injection | `if ('AbCdE' === 'FgHiJ') {…} else {…}` 形の述語（ランダムな文字列同士の比較）を評価し、偽になる枝と `if` を消す |
| [`decff`](tools/decff/) | control-flow-flattening | 辞書オブジェクト（`_0x13a459['ZJvAy'](a, b)` 形の間接呼び出し）を畳み、`'2\|0\|1'.split('\|')` + `while`/`switch` のディスパッチャを元の文順に戻す |
| [`deselfdefend`](tools/deselfdefend/) | self-defending | 呼び出しコントローラ・自己検査関数（`toString()` に正規表現を当てて整形を検出する罠）・起動文の 3 文を、元のテキストから切り出す |
| [`dedebug`](tools/dedebug/) | debug-protection | `debugger` を仕込んだ本体・起動部・呼び出しコントローラの 3 部品を取り除く |
| [`decompact`](tools/decompact/) | code-compact | javascript-obfuscator 自身と同じ escodegen で整形する。AST は 1 ノードも変えない |

各ツールは単体でも使える（`node tools/destring/strip-string-obfuscation.js in.js -o out.js`）。
詳しい仕組み・失敗条件・検証項目は各ディレクトリの README にある。

### なぜこの順序か

- 基本は**難読化を掛けた順の逆**。JsDeObsBench は 1 変換ずつ積み上げた設定（`1-1.json` → `1-7.json`）を
  持っており、その順は code-compact → debug-protection → name-obfuscation → self-defending →
  control-flow-flattening → deadcode-injection → string-obfuscation。この逆順から name-obfuscation を抜いたものが上の順になる。
- 動かせない制約は 1 つだけで、**self-defending を剥がしてから整形する**こと。self-defending は自分の関数の
  `toString()` に `(((.+)+)+)+$` を当てて整形を検出する。改行が 1 つでも入ると正規表現が破滅的なバックトラックを起こし、
  事実上ハングする。javascript-obfuscator 自身も `selfDefending: true` のとき `compact: true` を強制する。
- `destring` → `dedead` の順にすると、出力のブロックが 1 段浅くなる（逆順でも正しく動く）。

### 検証（ホールドアウト）

6 本はベンチマークのデータを一切見ずに開発した。テスト用に書き下ろしたプログラム（[`tools/*/testdata/src/`](tools/destring/testdata/src/)）を
javascript-obfuscator 5.7.0 で複数の設定・シードで難読化し、そのコーパスだけで検証している。
検証では、剥がした層が消えたこと、他の層を 1 バイトも変えていないこと、挙動が変わらないこと、
対象外の設定では壊れたコードを出さずに失敗すること、などを確かめる。
完成してから、JsDeObsBench の 200 問にチューニングなしで一度だけ掛けた結果が上の表である。

```bash
npm run gen-corpus   # 各ツールの testdata/obf/ を生成する（約 1.5 分）
npm run verify       # 6 本の verify.js をすべて回す
```

## 安全上の注意

`destring` と、その部品を借りる他のツールは、入力から取り出した文字列配列・デコーダ・ローテータを
`node:vm` で実行する。難読化されたプログラム本体は実行しないが、**`node:vm` はセキュリティ境界ではない**。
細工された入力はここから抜け出せる。素性の分からないコードやマルウェアを解析するときは、
使い捨てのコンテナや VM の中で動かすこと。解除結果を `node` で動かして確かめるときも同じである。

## 限界

- **対象は C77-0 相当の設定だけ**。`stringArrayEncoding`（base64 / rc4）、`stringArrayWrappersType: "function"`、
  `stringArrayCallsTransform`、`numbersToExpressions`、`splitStrings`、`transformObjectKeys` などが加わると、
  対応するツールは剥がせないと判断して非ゼロ終了する。壊れたコードは出さないが、その層は残る。
  たとえば `numbersToExpressions: true` ではデコーダ呼び出しの引数がリテラルでなくなるので、`destring` は剥がせない。
- C77-0 でも 200 問中 7 問（3.5%）は `self-defending` を剥がせず、self-defending と code-compact の 2 層が残る。
- 識別子名は LLM 頼みなので、名前の当否は保証できない。LLM が名前以外を書き換えることもある（上の「チャットで使った場合」）。
- 検証した LLM は Claude Opus 5 だけ。

## ディレクトリ構成

```
deobfuscate.js          6 ツールを順に掛ける（プロンプトの書き出しも）
tools/<6 本>/           各ツール本体・verify.js・gen-corpus.js・テスト用プログラム・README
prompts/                LLM に渡すプロンプト（JsDeObsBench とバイト一致）
examples/               自作プログラムで 1 周した例
reproduce/              JsDeObsBench での再現用（問題リスト・取り出し・LLM 一括・採点・期待値）
```

## ライセンス・出典

- このリポジトリのコードは [MIT License](LICENSE)。
- 評価に使ったベンチマーク: JsDeObsBench（[論文 arXiv:2506.20170](https://arxiv.org/abs/2506.20170) /
  [GitHub](https://github.com/Ch3nYe/JsDeObsBench)）。データセットと oneshot の例文は上流にあり、このリポジトリには含めていない。
- `prompts/zeroshot.txt` と `prompts/oneshot.txt` は JsDeObsBench のプロンプトを変えずに収録したもの。
- 難読化器: [javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator)（BSD-2-Clause）。
  検証コーパスの生成にだけ使う（devDependency）。
