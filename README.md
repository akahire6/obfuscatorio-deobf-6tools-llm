# obfuscatorio-deobf-6tools-llm

javascript-obfuscator（obfuscator.io）の **7 変換を同時に掛けた難読化**を、
**決定論スクリプト 6 本 + LLM 1 回**で解除する。

## 出典

このリポジトリは、次の発表で紹介した手法の実装である。

> 櫻井 慶裕, 杉山 量子, 岡本 剛（神奈川工科大学）:
> 「LLMによるJavaScriptの難読化解除」,
> コンピュータセキュリティシンポジウム2026（CSS2026）デモ&ポスターセッション, DP-46, 2026年10月.
> https://www.iwsec.org/css/2026/demo.html

## Overview (English)

This repository deobfuscates JavaScript produced by
[javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator) (obfuscator.io)
with seven transformations applied at once: string array, dead-code injection,
control-flow flattening, self-defending, debug protection, compact output and hexadecimal identifier renaming.
The settings are the same as those the [JsDeObsBench](https://github.com/Ch3nYe/JsDeObsBench) benchmark (CCS'25)
uses when it applies all seven transformations together.

- Six deterministic Node.js scripts (`scripts/`) strip six layers, one layer each, with Babel/acorn AST transforms.
  No LLM is involved at run time, and the output preserves behaviour.
  The scripts themselves were written with an LLM (Claude Code).
- Identifier names (`_0x1a2b3c`) cannot be recovered by AST rewriting, so the result goes to an LLM once,
  using the unmodified zero-shot prompt from JsDeObsBench (`prompts/zeroshot.txt`).
  A regular chat UI is enough: paste the generated prompt and copy back the code block.

This is the implementation of the method presented at CSS2026 (Computer Security Symposium 2026),
Demo & Poster Session, DP-46: 「LLMによるJavaScriptの難読化解除」 by 櫻井 慶裕, 杉山 量子 and 岡本 剛
(Kanagawa Institute of Technology).

```bash
npm install
node deobfuscate.js input.obf.js -o input.tools.js --prompt input.prompt.txt
# then paste input.prompt.txt into a new chat and take the first code block of the reply
```

> **Safety:** the scripts evaluate the string-array decoder extracted from the input inside `node:vm`,
> which is **not** a security sandbox. Run untrusted or malicious samples only inside a disposable container or VM.

---

## これは何か

```
難読化コード（7 変換）
  │ 1  scripts/destring       string-obfuscation       文字列配列・デコーダ・ローテータを畳み込む
  │ 2  scripts/dedead         deadcode-injection       不透明述語のダミー分岐を消す
  │ 3  scripts/decff          control-flow-flattening  辞書オブジェクトと switch ディスパッチャを元に戻す
  │ 4  scripts/deselfdefend   self-defending           整形を検出してハングさせる罠を外す
  │ 5  scripts/dedebug        debug-protection         debugger の検査ループを外す
  │ 6  scripts/decompact      code-compact             整形する
  ▼
識別子名だけが _0x1a2b3c のまま残ったコード      ← ここまで LLM なし
  │ LLM に 1 回（prompts/zeroshot.txt。チャットに貼るだけ）
  ▼
解除済みコード
```

7 変換のうち `name-obfuscation`（識別子を `_0x1a2b3c` に置き換える）だけは、元の名前の情報が
難読化の時点で失われている。AST をどう操作しても戻らないので、ここだけを LLM に任せる。
残り 6 層は機械的な変換なので、決定論スクリプトで剥がしたほうが確実で、挙動も壊れない。

6 本のスクリプトは LLM（Claude Code）を使って 1 層に 1 本ずつ作成した。実行時には LLM を使わない。

対象の 7 変換と設定は、JsDeObsBench（CCS'25 のベンチマーク）が 7 変換を同時に掛けるときの設定と同じ
（[`examples/obfuscator-config.json`](examples/obfuscator-config.json) に同じ効果の設定を置いた）。

## 必要なもの

- Node.js 18 以上
- 識別子名を戻すための LLM（チャットでよい）

## 使い方

### 1. インストール

```bash
git clone https://github.com/akahire6/obfuscatorio-deobf-6tools-llm.git
cd obfuscatorio-deobf-6tools-llm
npm install
```

### 2. スクリプトで 6 層を剥がす

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
- スクリプトが剥がせないと判断した段は、壊れたコードを出さずに非ゼロ終了する。
  `deobfuscate.js` はその段を飛ばし、前段のコードを次の段に渡す。
  `self-defending` が剥がせなかったときは、罠が発火しないよう最後の整形（`code-compact`）も掛けない。
  このとき終了コードは 3 になる（出力は書かれる）。

### 3. LLM に識別子名を戻させる（チャット）

推奨する条件:

- **プロンプト**: `input.prompt.txt` の中身を、英語のまま 1 文字も変えずに全文貼る
  （JsDeObsBench の zero-shot プロンプトそのもの）。
- **会話**: 1 ファイルにつき新しい会話を 1 つ使い、1 回だけ答えさせる。追加の指示はしない。
- **余計な前置きを入れない**: カスタム指示やメモリ、Web 検索・コード実行などの機能は、オフにできるならオフにする。
- **モデル**: Claude Opus 5 で確認している。
- **結果**: 返答の**最初のコードブロックの中身**を解除結果とする。

## 例

[`examples/`](examples/) に、自作の小さなプログラムで 1 周した結果を置いた。

| ファイル | 中身 | 文字数 |
|---|---|---:|
| [`sample.js`](examples/sample.js) | 原本 | 883 |
| [`sample.obf.js`](examples/sample.obf.js) | [`obfuscator-config.json`](examples/obfuscator-config.json) で難読化（seed=1） | 9,636 |
| [`sample.tools.js`](examples/sample.tools.js) | 6 本のスクリプトの出力（識別子名以外は解除済み） | 1,379 |
| [`sample.prompt.txt`](examples/sample.prompt.txt) | チャットに貼るプロンプト | — |
| [`sample.llm.js`](examples/sample.llm.js) | 上の条件で LLM が返したコード | — |

4 つの `.js` はどれも同じ出力を返す（`node examples/sample.llm.js`）。スクリプトの出力では局所変数名が
`_0x399358` のまま残っているが、LLM を通すと戻る。

```js
// sample.tools.js（6 本のスクリプトの出力）
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

難読化をやり直すときは `npx javascript-obfuscator examples/sample.js --config examples/obfuscator-config.json --seed 1 --output out.js`。

## 6 本のスクリプト

| スクリプト | 剥がす層 | やり方 |
|---|---|---|
| [`destring`](scripts/destring/) | string-obfuscation | 文字列配列・デコーダ・ローテータの 3 部品だけを `node:vm` で実行し、呼び出しを実リテラルに畳み込んでから部品ごと消す。デコーダの中身は読み解かない |
| [`dedead`](scripts/dedead/) | deadcode-injection | `if ('AbCdE' === 'FgHiJ') {…} else {…}` 形の述語（ランダムな文字列同士の比較）を評価し、偽になる枝と `if` を消す |
| [`decff`](scripts/decff/) | control-flow-flattening | 辞書オブジェクト（`_0x13a459['ZJvAy'](a, b)` 形の間接呼び出し）を畳み、`'2\|0\|1'.split('\|')` + `while`/`switch` のディスパッチャを元の文順に戻す |
| [`deselfdefend`](scripts/deselfdefend/) | self-defending | 呼び出しコントローラ・自己検査関数（`toString()` に正規表現を当てて整形を検出する罠）・起動文の 3 文を、元のテキストから切り出す |
| [`dedebug`](scripts/dedebug/) | debug-protection | `debugger` を仕込んだ本体・起動部・呼び出しコントローラの 3 部品を取り除く |
| [`decompact`](scripts/decompact/) | code-compact | javascript-obfuscator 自身と同じ escodegen で整形する。AST は 1 ノードも変えない |

各スクリプトは単体でも使える（`node scripts/destring/strip-string-obfuscation.js in.js -o out.js`）。
詳しい仕組み・失敗条件・検証項目は各ディレクトリの README にある。

### なぜこの順序か

- 基本は**難読化を掛けた順の逆**。JsDeObsBench は難読化を 1 変換ずつ積み上げた設定も
  用意しており、その積み上げ順は code-compact → debug-protection → name-obfuscation → self-defending →
  control-flow-flattening → deadcode-injection → string-obfuscation。この逆順から name-obfuscation を抜いたものが上の順になる。
- 動かせない制約は 1 つだけで、**self-defending を剥がしてから整形する**こと。self-defending は自分の関数の
  `toString()` に `(((.+)+)+)+$` を当てて整形を検出する。改行が 1 つでも入ると正規表現が破滅的なバックトラックを起こし、
  事実上ハングする。javascript-obfuscator 自身も `selfDefending: true` のとき `compact: true` を強制する。
- `destring` → `dedead` の順にすると、出力のブロックが 1 段浅くなる（逆順でも正しく動く）。

### 検証

6 本はベンチマークのデータを一切見ずに開発した。テスト用に書き下ろしたプログラム（[`scripts/*/testdata/src/`](scripts/destring/testdata/src/)）を
javascript-obfuscator 5.7.0 で複数の設定・シードで難読化し、そのコーパスだけで検証している。
検証では、剥がした層が消えたこと、他の層を 1 バイトも変えていないこと、挙動が変わらないこと、
対象外の設定では壊れたコードを出さずに失敗すること、などを確かめる。

```bash
npm run gen-corpus   # 各スクリプトの testdata/obf/ を生成する（約 1.5 分）
npm run verify       # 6 本の verify.js をすべて回す
```

## 安全上の注意

`destring` と、その部品を借りる他のスクリプトは、入力から取り出した文字列配列・デコーダ・ローテータを
`node:vm` で実行する。難読化されたプログラム本体は実行しないが、**`node:vm` はセキュリティ境界ではない**。
細工された入力はここから抜け出せる。素性の分からないコードやマルウェアを解析するときは、
使い捨てのコンテナや VM の中で動かすこと。解除結果を `node` で動かして確かめるときも同じである。

## 限界

- **対象は上記の 7 変換の設定だけ**。`stringArrayEncoding`（base64 / rc4）、`stringArrayWrappersType: "function"`、
  `stringArrayCallsTransform`、`numbersToExpressions`、`splitStrings`、`transformObjectKeys` などが加わると、
  対応するスクリプトは剥がせないと判断して非ゼロ終了する。壊れたコードは出さないが、その層は残る。
  たとえば `numbersToExpressions: true` ではデコーダ呼び出しの引数がリテラルでなくなるので、`destring` は剥がせない。
- 対象の設定で難読化した入力でも、まれに `self-defending` を剥がせないことがある。そのときは self-defending と code-compact の 2 層が残る。
- 識別子名は LLM 頼みなので、名前の当否は保証できない。LLM が名前以外の書き方を変えることもある。

## ディレクトリ構成

```
deobfuscate.js          6 本のスクリプトを順に掛ける（プロンプトの書き出しも）
scripts/<6 本>/         各スクリプト本体・verify.js・gen-corpus.js・テスト用プログラム・README
prompts/zeroshot.txt    LLM に渡すプロンプト（JsDeObsBench とバイト一致）
examples/               自作プログラムで 1 周した例
```

## ライセンス・参照

- このリポジトリのコードは [MIT License](LICENSE)。
- 対象の難読化設定とプロンプトの出典: JsDeObsBench（[論文 arXiv:2506.20170](https://arxiv.org/abs/2506.20170) /
  [GitHub](https://github.com/Ch3nYe/JsDeObsBench)）。`prompts/zeroshot.txt` は同ベンチマークのプロンプトを変えずに収録したもの。
- 難読化器: [javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator)（BSD-2-Clause）。
  検証コーパスの生成にだけ使う（devDependency）。
