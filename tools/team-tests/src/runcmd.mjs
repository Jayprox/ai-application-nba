// `estimate` and `run` commands. `run` checks the guard first and only then imports the launcher
// (dynamic import, so nothing on the dry-run path can reach it). Never spawns anything itself.
import { checkRun } from './guard.mjs';
import { GuardRefusal } from './refusal.mjs';
import { parseRunSet, estimateText, estimateSha256 } from './estimate.mjs';

function flags(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!allowed.includes(k) || argv[i + 1] === undefined || k in out) throw new GuardRefusal('usage', `unexpected or repeated argument ${String(k).replace(/[^\w-]/g, '?')}`);
    out[k] = argv[i + 1];
  }
  return out;
}

const cap = (v, name) => {
  const n = Number(v);
  if (!(Number.isFinite(n) && n > 0)) throw new GuardRefusal('usage', `${name} must be a positive number`);
  return n;
};

/** `estimate --run G3:3,G1:3 --max-sessions 6 --max-usd-session 5 --max-usd-total 20` -> text + sha256 line. */
export function estimateCommand(argv) {
  const f = flags(argv, ['--run', '--max-sessions', '--max-usd-session', '--max-usd-total']);
  for (const k of ['--run', '--max-sessions', '--max-usd-session', '--max-usd-total']) if (!(k in f)) throw new GuardRefusal('usage', `${k} is required`);
  const params = { runSet: parseRunSet(f['--run']), maxSessions: cap(f['--max-sessions'], '--max-sessions'), maxUsdPerSession: cap(f['--max-usd-session'], '--max-usd-session'), maxUsdTotal: cap(f['--max-usd-total'], '--max-usd-total') };
  return `${estimateText(params)}sha256 of the text above (put in the approval file as estimateSha256): ${estimateSha256(params)}\n`;
}

/**
 * `run --approval <file> --run G3:3,G1:3 [--keychain-service <name>]`. Throws GuardRefusal before any spawn if the guard fails.
 * `deps.importLauncher` exists so tests can prove the launcher is not imported on a refusal.
 */
export async function runCommand(argv, { env = process.env, repoRoot, now = new Date(), importLauncher = () => import('./launch.mjs'), guardOpts = {}, launchOpts = {}, log = () => {} } = {}) {
  const f = flags(argv, ['--approval', '--run', '--keychain-service']);
  if (!('--run' in f)) throw new GuardRefusal('run-set', '--run <G3:3,...> is required');
  let runSet;
  try { runSet = parseRunSet(f['--run']); } catch { throw new GuardRefusal('run-set', 'run set is not valid'); }
  const plan = checkRun({ approvalPath: f['--approval'], runSet, env, now, repoRoot, ...guardOpts });
  const launcher = await importLauncher();
  const keychain = f['--keychain-service'] ? { keychainService: f['--keychain-service'] } : {};
  return launcher.launchAll({ plan, repoRoot, env, log, ...keychain, ...launchOpts });
}
