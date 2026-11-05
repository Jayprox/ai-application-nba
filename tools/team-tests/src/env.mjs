// Child environment built from an allowlist. Nothing is inherited from the parent
// except a sanitised LANG (the parent env is read for that one key only).
import path from 'node:path';

export const ENV_KEYS = Object.freeze([
  'HOME', 'PATH', 'TMPDIR', 'LANG', 'TERM', 'USER', 'LOGNAME',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT',
  'npm_config_offline', 'npm_config_registry', 'FIXTURE_DB_TOKEN',
]);

export function buildChildEnv({ scratch, canary, parentEnv = process.env }) {
  if (typeof scratch !== 'string' || !path.isAbsolute(scratch)) throw new Error('buildChildEnv: scratch must be absolute');
  if (typeof canary !== 'string' || canary === '') throw new Error('buildChildEnv: canary required');
  const lang = /^[A-Za-z0-9_.@-]{1,32}$/.test(parentEnv.LANG ?? '') ? parentEnv.LANG : 'C';
  return {
    HOME: path.join(scratch, 'home'),
    PATH: `${path.join(scratch, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: path.join(scratch, 'tmp'),
    LANG: lang,
    TERM: 'dumb',
    USER: 'fixture',
    LOGNAME: 'fixture',
    GIT_CONFIG_GLOBAL: path.join(scratch, 'home', '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:9',
    FIXTURE_DB_TOKEN: canary,
  };
}
