#!/usr/bin/env node
// Owner-run, costs real money, NOT part of `npm test` and never run in CI (STANDARDS section 2).
// Runs the labelled corpus through the real model (same prompt, same client as the background worker) and
// prints where the model disagrees with the expected decision, plus the cost.
//
//   node live-eval.mjs --i-understand-this-costs-money [--install-dir <dir>] [--max-usd 0.50] [--limit N]
//
// It reads the API key from the Keychain exactly as the worker does. Without the flag it refuses to start.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstall } from '../src/config.mjs';
import { readKey } from '../src/model/keychain.mjs';
import { askModel, buildPrompt, buildBody, estimateCostUsd, costFromUsage } from '../src/model/client.mjs';
import { modelTarget, redact } from '../src/log.mjs';

const FLAG = '--i-understand-this-costs-money';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

if (!args.includes(FLAG)) {
  console.error(`live-eval refuses to run: it calls the real model and costs money.\nRe-run with ${FLAG} if that is what you want.`);
  process.exit(2);
}

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installDir = opt('--install-dir', here);
const inst = loadInstall(installDir);
if (!inst.ok || !inst.install.model?.enabled) { console.error('live-eval needs an installed approver with model settings in install.json (' + (inst.error || 'model disabled') + ')'); process.exit(2); }
const { model, keychain } = inst.install;
const maxUsd = Number(opt('--max-usd', '0.50'));
const limit = Number(opt('--limit', '1000'));
const policyMd = fs.readFileSync(path.join(installDir, 'policy.md'), 'utf8');
const corpus = JSON.parse(fs.readFileSync(path.join(here, 'test', 'fixtures', 'requests.json'), 'utf8'))
  .filter((i) => i.tool && i.input && !i.fault && i.raw_stdin === undefined && ['Bash', 'Edit', 'Write', 'NotebookEdit'].includes(i.tool)).slice(0, limit);

const k = await readKey({ service: keychain?.service, account: keychain?.account });
if (!k.ok) { console.error('Keychain key not available'); process.exit(2); }

let spent = 0; let n = 0; const mismatches = [];
for (const item of corpus) {
  const input = JSON.parse(JSON.stringify(item.input).replace(/\{\{[A-Z]+\}\}/g, '/repo').replace(/\{\{FILLER:\d+\}\}/g, 'word '.repeat(50)));
  const { system, user } = buildPrompt({ policyMd, request: { tool: item.tool, command_or_path: redact(modelTarget(item.tool, input)), cwd: '/repo', branch: item.branch } });
  if (spent + estimateCostUsd({ system, user, maxTokens: model.max_tokens }, model.prices) > maxUsd) { console.log(`stopping at the --max-usd cap (${maxUsd})`); break; }
  const r = await askModel({ key: k.key, body: buildBody({ model: model.name, maxTokens: model.max_tokens, system, user }), timeoutMs: model.timeout_ms });
  n++;
  if (!r.ok) { mismatches.push(`${item.id}: model call failed (${r.error})`); continue; }
  spent += costFromUsage(r.usage, model.prices);
  if (r.decision !== item.expected) mismatches.push(`${item.id}: expected ${item.expected}, model said ${r.decision} (${redact(r.reason)})`);
}
console.log(`live-eval: ${n} requests, ${mismatches.length} mismatches, cost about US$${spent.toFixed(4)}`);
for (const m of mismatches) console.log('  ' + m);
