#!/usr/bin/env node
/**
 * プロンプトのディレクトリを Claude Code CLI（claude -p）に 1 問 1 回ずつ投げ、
 * 応答の最初のコードブロックを <name>.deobf.js に書く。
 *
 * チャット画面に 1 問ずつ貼るのと同じことを、問題数が多いときに自動でやるための補助。
 * 使うには Claude Code（https://claude.com/claude-code）のインストールとログインが必要。
 *
 *   node reproduce/ask-claude.js <promptdir> <outdir> [--mode chat|experiment] [--model <id>]
 *                                [--concurrency 4] [--overwrite]
 *
 * --mode chat（既定）
 *     Claude Code のシステムプロンプトを空にし、ツールを全部外す。
 *     チャット画面に貼って 1 回答えさせるのに近い条件。
 * --mode experiment
 *     実験（論文用の測定）で使った呼び方そのもの。Claude Code の既定システムプロンプトに
 *     prompts/system_benchmark.txt（出力の形だけを指定する文）を足し、ツールを禁止する。
 *
 * コードの抽出規則は JsDeObsBench の query_vllm.py と同じ正規表現。
 * 抽出に 2 回失敗した問題は <name>.raw.txt だけ残し、.deobf.js は書かない。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CODE_BLOCK = /```[a-zA-Z, ]*\n([\s\S]+?)\n```/;
const DISALLOWED = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite';

function parseArgs(argv) {
  const o = { mode: 'chat', model: 'claude-opus-5', concurrency: 4, overwrite: false, timeout: 300, retry: 2, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') o.mode = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]);
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--overwrite') o.overwrite = true;
    else o.pos.push(a);
  }
  if (o.pos.length !== 2 || !['chat', 'experiment'].includes(o.mode)) {
    process.stderr.write(
      '使い方: node reproduce/ask-claude.js <promptdir> <outdir> [--mode chat|experiment] [--model <id>] [--concurrency 4] [--overwrite]\n'
    );
    process.exit(2);
  }
  return o;
}

function claudeArgs(o) {
  const args = ['-p', '--output-format', 'json', '--model', o.model, '--no-session-persistence'];
  if (o.mode === 'chat') {
    args.push('--system-prompt', '', '--tools', '', '--strict-mcp-config', '--safe-mode');
  } else {
    const sp = fs.readFileSync(path.join(ROOT, 'prompts', 'system_benchmark.txt'), 'utf8').trim();
    args.push('--append-system-prompt', sp, '--disallowed-tools', DISALLOWED);
  }
  return args;
}

function callClaude(args, prompt, timeoutSec) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout (${timeoutSec}s)`)); }, timeoutSec * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try {
        const data = JSON.parse(out);
        if (data.is_error) return reject(new Error(`claude is_error: ${String(data.result).slice(0, 300)}`));
        resolve({ text: data.result || '', cost: Number(data.total_cost_usd || 0) });
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(prompt);
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const [promptDir, outDir] = o.pos;
  fs.mkdirSync(outDir, { recursive: true });
  const args = claudeArgs(o);

  const todo = fs.readdirSync(promptDir)
    .filter((f) => f.endsWith('.prompt.txt'))
    .sort()
    .map((f) => f.slice(0, -'.prompt.txt'.length))
    .filter((n) => o.overwrite || !fs.existsSync(path.join(outDir, `${n}.deobf.js`)));

  process.stderr.write(`mode=${o.mode} model=${o.model} 対象 ${todo.length} 問\n`);
  let done = 0, failed = 0, cost = 0;

  async function one(name) {
    const prompt = fs.readFileSync(path.join(promptDir, `${name}.prompt.txt`), 'utf8');
    let lastErr = '';
    for (let attempt = 1; attempt <= o.retry; attempt++) {
      try {
        const r = await callClaude(args, prompt, o.timeout);
        cost += r.cost;
        fs.writeFileSync(path.join(outDir, `${name}.raw.txt`), r.text);
        const m = CODE_BLOCK.exec(r.text);
        if (m && m[1].trim()) {
          fs.writeFileSync(path.join(outDir, `${name}.deobf.js`), m[1]);
          done += 1;
          return;
        }
        lastErr = 'コードブロックを抽出できませんでした';
      } catch (e) {
        lastErr = e.message;
      }
    }
    failed += 1;
    process.stderr.write(`  [!] ${name}: ${lastErr}\n`);
  }

  const queue = [...todo];
  const workers = Array.from({ length: Math.max(1, o.concurrency) }, async () => {
    while (queue.length) {
      await one(queue.shift());
      const n = done + failed;
      if (n % 10 === 0 || n === todo.length) {
        process.stderr.write(`  ${n}/${todo.length}  成功 ${done} / 失敗 ${failed}  $${cost.toFixed(2)}\n`);
      }
    }
  });
  await Promise.all(workers);
  process.stderr.write(`完了: 成功 ${done} / 失敗 ${failed}  （CLI が報告した費用 $${cost.toFixed(2)}）\n`);
  process.exit(failed ? 3 : 0);
}

main();
