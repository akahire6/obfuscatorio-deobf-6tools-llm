#!/usr/bin/env node
/**
 * deobfuscate.js — obfuscator.io の 7 変換複合を、決定論ツール 6 本で順に剥がす。
 *
 *   input.js
 *     → destring → dedead → decff → deselfdefend → dedebug → decompact
 *     = 識別子名（name-obfuscation）以外は解除済みのコード
 *
 * 残る name-obfuscation は AST 操作では復元できないので、LLM に 1 回渡す。
 * `--prompt` を付けると、prompts/zeroshot.txt に解除済みコードを埋め込んだ
 * 「そのままチャットに貼れるプロンプト」も書き出す。
 *
 * 使い方:
 *   node deobfuscate.js input.js -o output.js
 *   node deobfuscate.js input.js -o output.js --prompt prompt.txt
 *   node deobfuscate.js input.js --work-dir work/      # 各段の中間コードと pipeline.json を残す
 *   node deobfuscate.js --batch <indir> -o <outdir> [--prompt <promptdir>]
 *
 * 失敗時の扱い（実験で使った run_hybrid.py と同じ）:
 *   - ツールが非ゼロ終了したら、その段は飛ばして前段のコードを次に渡す（carry）。
 *   - self-defending を剥がせなかったときは code-compact を掛けない。
 *     self-defending は自分の関数の toString() が 1 行かどうかで整形を検出し、
 *     改行が入るとハングする罠を持つ。残ったまま整形すると、動かないコードになる。
 *
 * 終了コード: 0 = 6 本すべて成功 / 3 = 一部のツールが失敗（出力は書いている）/
 *             1 = 入出力のエラー / 2 = 引数の誤り
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;

// 適用順。順序には理由がある（README「なぜこの順序か」）。
const TOOLS = [
  { name: 'string-obfuscation', script: 'tools/destring/strip-string-obfuscation.js' },
  { name: 'deadcode-injection', script: 'tools/dedead/strip-deadcode-injection.js' },
  { name: 'control-flow-flattening', script: 'tools/decff/strip-control-flow-flattening.js' },
  { name: 'self-defending', script: 'tools/deselfdefend/strip-self-defending.js' },
  { name: 'debug-protection', script: 'tools/dedebug/strip-debug-protection.js' },
  { name: 'code-compact', script: 'tools/decompact/strip-code-compact.js' },
];

const DEFAULT_TEMPLATE = path.join(ROOT, 'prompts', 'zeroshot.txt');

const USAGE = `使い方:
  node deobfuscate.js <input.js> [-o <output.js>] [--prompt <prompt.txt>] [--work-dir <dir>]
  node deobfuscate.js --batch <indir> -o <outdir> [--prompt <promptdir>] [--work-dir <dir>]

オプション:
  -o, --out <path>     出力先。単一ファイルでは省略すると stdout。--batch では出力ディレクトリ（必須）
  --prompt <path>      LLM に渡すプロンプト（テンプレートにコードを埋め込んだもの）を書き出す。
                       --batch ではディレクトリを指定し <name>.prompt.txt を書く
  --template <file>    プロンプトのテンプレート（既定: prompts/zeroshot.txt）
  --example <file>     テンプレートの {example} に入れる文（prompts/oneshot.txt を使うときに必要）
  --work-dir <dir>     各段の中間コードと pipeline.json を残す（既定は一時ディレクトリに作って消す）
  --batch <indir>      ディレクトリ内の --ext に合うファイルを一括処理する
  --ext <ext>          --batch の入力拡張子（既定: .js）
  --suffix <suffix>    --batch の出力拡張子（既定: .tools.js）
  --timeout <sec>      ツール 1 本あたりの上限秒数（既定: 300）
  -q, --quiet          進捗を表示しない
  -h, --help           このヘルプ
`;

function parseArgs(argv) {
  const opts = {
    input: null, out: null, prompt: null, template: DEFAULT_TEMPLATE, example: null, workDir: null,
    batch: null, ext: '.js', suffix: '.tools.js', timeout: 300, quiet: false,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} には値が必要`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === '-o' || a === '--out') {
      opts.out = need(i, a); i++;
    } else if (a === '--prompt') {
      opts.prompt = need(i, a); i++;
    } else if (a === '--template') {
      opts.template = need(i, a); i++;
    } else if (a === '--example') {
      opts.example = need(i, a); i++;
    } else if (a === '--work-dir') {
      opts.workDir = need(i, a); i++;
    } else if (a === '--batch') {
      opts.batch = need(i, a); i++;
    } else if (a === '--ext') {
      opts.ext = need(i, a); i++;
    } else if (a === '--suffix') {
      opts.suffix = need(i, a); i++;
    } else if (a === '--timeout') {
      opts.timeout = Number(need(i, a)); i++;
      if (!(opts.timeout > 0)) throw new Error('--timeout は正の数');
    } else if (a === '-q' || a === '--quiet') {
      opts.quiet = true;
    } else if (a.startsWith('-')) {
      throw new Error(`不明なオプション: ${a}`);
    } else if (opts.input === null) {
      opts.input = a;
    } else {
      throw new Error(`入力ファイルは 1 つだけ: ${a}`);
    }
  }
  return opts;
}

/** ツールを 1 本走らせる。例外は投げず、結果を返す。 */
function runTool(script, src, dst, timeoutSec) {
  const started = Date.now();
  const proc = spawnSync(process.execPath, [script, src, '-o', dst, '--stats'], {
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsedSec = Math.round((Date.now() - started) / 10) / 100;
  if (proc.error && proc.error.code === 'ETIMEDOUT') {
    return { status: 'failed', error: `timeout (${timeoutSec}s)`, elapsedSec };
  }
  if (proc.status !== 0 || !fs.existsSync(dst)) {
    const msg = (proc.stderr || String(proc.error || '')).trim().slice(0, 800);
    return { status: 'failed', returncode: proc.status, error: msg, elapsedSec };
  }
  return { status: 'ok', stats: parseStatsLine(proc.stderr), elapsedSec };
}

/** `--stats` が stderr に出す `<basename>: {json}` の 1 行を拾う。 */
function parseStatsLine(stderr) {
  const lines = (stderr || '').trim().split('\n').reverse();
  for (const line of lines) {
    const brace = line.indexOf('{');
    if (brace < 0) continue;
    try {
      return JSON.parse(line.slice(brace));
    } catch (_) {
      // 次の行へ
    }
  }
  return null;
}

/**
 * 1 ファイルについて 6 ツールを順に掛ける。
 * 返り値: { code, record }。record は pipeline.json の中身。
 */
function runPipeline(obfuscated, workDir, opts, log) {
  fs.mkdirSync(workDir, { recursive: true });
  let current = path.join(workDir, '00.input.js');
  fs.writeFileSync(current, obfuscated);

  let code = obfuscated;
  let selfDefendFailed = false;
  const record = { input_chars: obfuscated.length, tools: [] };

  TOOLS.forEach((tool, idx) => {
    const i = idx + 1;
    const entry = { index: i, transformation: tool.name, script: tool.script, input_chars: code.length };

    if (tool.name === 'code-compact' && selfDefendFailed) {
      entry.status = 'skipped';
      entry.reason = 'self-defending が剥がれていないため整形しない';
      record.tools.push(entry);
      log(`  [${i}/6] ${tool.name.padEnd(24)} skip（self-defending が残っているので整形しない）`);
      return;
    }

    const dst = path.join(workDir, `${String(i).padStart(2, '0')}.${tool.name}.js`);
    const r = runTool(path.join(ROOT, tool.script), current, dst, opts.timeout);
    Object.assign(entry, r);

    if (r.status === 'ok') {
      const next = fs.readFileSync(dst, 'utf8');
      entry.output_chars = next.length;
      entry.code_changed = next !== code;
      log(`  [${i}/6] ${tool.name.padEnd(24)} ${String(code.length).padStart(7)} → ${String(next.length).padStart(7)} 文字`);
      code = next;
      current = dst;
    } else {
      if (tool.name === 'self-defending') selfDefendFailed = true;
      entry.output_chars = code.length;
      entry.carried_forward = true;
      log(`  [${i}/6] ${tool.name.padEnd(24)} 失敗（前段のコードを引き継ぐ）: ${(r.error || '').split('\n')[0]}`);
    }
    record.tools.push(entry);
  });

  const failed = record.tools.filter((t) => t.status === 'failed').map((t) => t.transformation);
  Object.assign(record, {
    final_chars: code.length,
    reduction_pct: obfuscated.length ? Math.round(10000 * (1 - code.length / obfuscated.length)) / 100 : 0,
    failed_tools: failed,
    status: failed.length ? 'partial' : 'ok',
  });
  fs.writeFileSync(path.join(workDir, 'pipeline.json'), JSON.stringify(record, null, 2) + '\n');
  return { code, record };
}

/**
 * テンプレートの {example} と {obfuscated_code} を埋める。
 * String#replace の `$` 置換を避けて split/join を使う。埋め込むコードの中に
 * "{example}" という文字列があっても誤爆しないよう、{example} を先に埋める。
 */
function renderPrompt(template, code, example = '') {
  return template.split('{example}').join(example).split('{obfuscated_code}').join(code);
}

/** プロンプトを書き出すなら、テンプレートと {example} の文を先に読んで確かめる。 */
function loadPromptParts(opts) {
  if (!opts.prompt) return null;
  const template = fs.readFileSync(opts.template, 'utf8');
  if (template.includes('{example}') && !opts.example) {
    throw new Error(`${opts.template} には {example} がある。--example <file> で例文を渡すこと` +
                    '（作り方は prompts/README.md）');
  }
  return { template, example: opts.example ? fs.readFileSync(opts.example, 'utf8') : '' };
}

function processOne(inFile, outFile, promptFile, workDir, opts, parts, log) {
  const obfuscated = fs.readFileSync(inFile, 'utf8');
  const tmp = workDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'deobf-'));
  try {
    const { code, record } = runPipeline(obfuscated, workDir || tmp, opts, log);
    if (outFile) {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, code);
    } else {
      process.stdout.write(code);
    }
    if (promptFile) {
      fs.mkdirSync(path.dirname(path.resolve(promptFile)), { recursive: true });
      fs.writeFileSync(promptFile, renderPrompt(parts.template, code, parts.example));
    }
    return record;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const log = opts.quiet ? () => {} : (s) => process.stderr.write(s + '\n');
  let parts;
  try {
    parts = loadPromptParts(opts);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  // --- バッチ ---
  if (opts.batch) {
    if (!opts.out) {
      process.stderr.write('--batch には -o <outdir> が必要\n');
      process.exit(2);
    }
    const files = fs.readdirSync(opts.batch).filter((f) => f.endsWith(opts.ext)).sort();
    let partial = 0;
    files.forEach((f, k) => {
      const base = f.slice(0, f.length - opts.ext.length);
      log(`[${k + 1}/${files.length}] ${f}`);
      const rec = processOne(
        path.join(opts.batch, f),
        path.join(opts.out, base + opts.suffix),
        opts.prompt ? path.join(opts.prompt, base + '.prompt.txt') : null,
        opts.workDir ? path.join(opts.workDir, base) : null,
        opts,
        parts,
        log,
      );
      if (rec.status !== 'ok') partial += 1;
    });
    log(`\n処理 ${files.length} 件: 全ツール成功 ${files.length - partial} / 一部失敗 ${partial}`);
    process.exit(partial ? 3 : 0);
  }

  // --- 単一ファイル ---
  if (!opts.input) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  let rec;
  try {
    rec = processOne(opts.input, opts.out, opts.prompt, opts.workDir, opts, parts, log);
  } catch (err) {
    process.stderr.write(`失敗: ${opts.input}\n  ${err.message}\n`);
    process.exit(1);
  }
  log(`${rec.input_chars} → ${rec.final_chars} 文字（-${rec.reduction_pct}%）` +
      (rec.status === 'ok' ? '' : `  一部失敗: ${rec.failed_tools.join(', ')}`));
  process.exit(rec.status === 'ok' ? 0 : 3);
}

if (require.main === module) main();

module.exports = { TOOLS, runPipeline, renderPrompt };
