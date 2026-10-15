# prompts

| ファイル | 用途 | 出典 |
|---|---|---|
| [`zeroshot.txt`](zeroshot.txt) | **チャットで使うのはこれ**。`deobfuscate.js --prompt` の既定 | JsDeObsBench とバイト一致 |
| [`oneshot.txt`](oneshot.txt) | 例を 1 つ見せる版。`{example}` を埋める必要がある | JsDeObsBench とバイト一致 |
| [`system_benchmark.txt`](system_benchmark.txt) | 実験で `claude -p` に足したシステムプロンプト。チャットでは使わない | このリポジトリ |

## zeroshot.txt

`{obfuscated_code}` に 6 ツールの出力を入れたものを、そのまま LLM に送る。
`node deobfuscate.js input.js --prompt prompt.txt` で埋め込み済みのファイルができる。

文言は JsDeObsBench（論文）の zero-shot プロンプトそのままで、6 ツールの出力向けには書き換えていない。
入力が「識別子名以外は解除済み」のコードになっても、このままで識別子名が戻ることを確かめてある（ルートの README の結果）。

## oneshot.txt

`{example}` には、JsDeObsBench の `deobfuscators/examples.json` にある `combinations/C77-0` の例
（難読化コードと原本の対）が入る。例は上流のデータなのでこのリポジトリには含めていない。
上流をクローンしてから次のように作る。

```bash
node reproduce/jsdeobsbench.js example JsDeObsBench/deobfuscators/examples.json > example.txt
node deobfuscate.js input.js --prompt prompt.txt --template prompts/oneshot.txt --example example.txt
```

できる文字列は上流の `build_example_prompt()` と同じで、実験で使ったプロンプトとバイト単位で一致する。
例が 7 層かかったままのコードを見せるのに対し、入力は 6 層剥がれたコードなので食い違いがある。
それでも 200 問では zeroshot より similarity が 2.0pt 高かった（60.64 対 58.61）。
プロンプトがそのぶん長くなるので、チャットでは zeroshot で十分である。

## system_benchmark.txt

実験では LLM を Claude Code の CLI（`claude -p`）で呼んだ。CLI は対話用のシステムプロンプトを伴うので、
oneshot プロンプトを「例が 2 つあって 2 つ目の答えが欠けた依頼」と読み、聞き返してくることがあった。
これを防ぐために、**出力の形だけ**を指定する文を足した（解除のヒントは含めていない）。
チャットや API で直接送るときは不要。`reproduce/ask-claude.js --mode experiment` がこれを使う。
