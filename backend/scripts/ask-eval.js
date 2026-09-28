// Live check of the search planner against real questions (costs ~30 Haiku
// calls, well under $0.10). From the Mac, with ANTHROPIC_API_KEY in the
// repo-root .env:   npm run ask:eval
// Each case lists only the plan fields that MUST match; extra fields are fine.
// A RegExp matches against the value as a string ('' when omitted = the default season).
import { readFileSync } from 'node:fs';
import { createLlm } from '../src/ask/llm.js';
import { normalizePlan, PLAN_TOOL, systemPrompt } from '../src/ask/planner.js';

try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const CASES = [
  ['Jokic on the second night of back to backs this season', { kind: 'player_stats', b2b: 2 }],
  ['how has SGA played his last 10 games', { kind: 'player_stats', scope: 'last10' }],
  ['Brunson on the road on no rest', { kind: 'player_stats', venue: 'away', rest: '0' }],
  ['LeBron career playoff averages', { kind: 'player_stats', scope: 'career', season_type: 'playoffs' }],
  ['Curry 3 point percentage 2015-16', { kind: 'player_stats', season: '2015-16', stat: 'fg3_pct' }],
  ['Tatum game log two seasons ago', { kind: 'player_stats', scope: 'game_log', season: '2024-25' }],
  ['Edwards on national TV', { kind: 'player_stats', national_tv: 'major' }],
  ['how do the Warriors play at altitude', { kind: 'team_stats', altitude: true }],
  ['Celtics record at home', { kind: 'team_stats', venue: 'home' }],
  ['Knicks defensive rating in the playoffs', { kind: 'team_stats', season_type: 'playoffs', stat: 'def_rtg' }],
  ['Thunder in the NBA Cup', { kind: 'team_stats', season_type: 'cup' }],
  ['who leads the league in steals', { kind: 'leaders', stat: 'stl' }],
  ['top 10 scorers 2015-16', { kind: 'leaders', stat: 'pts', season: '2015-16', limit: 10 }],
  ['most threes per game last season', { kind: 'leaders', stat: 'fg3m', season: /^(2025-26|)$/ }],
  ['who has the highest usage rate', { kind: 'leaders', stat: 'usg_pct' }],
  ['Jokic usage rate this season', { kind: 'player_stats', stat: 'usg_pct' }],
  ['best centers in the league', { kind: 'player_rankings', position: 'C' }],
  ['top 5 point guards over the last 10 games', { kind: 'player_rankings', position: 'G', scope: 'last10' }],
  ['best defense in the NBA', { kind: 'team_rankings', stat: 'def_rtg' }],
  ['which team plays the fastest', { kind: 'team_rankings', stat: 'pace' }],
  ['worst offense', { kind: 'team_rankings', stat: 'off_rtg', order: 'worst' }],
  ['which teams give up the most points to centers', { kind: 'matchups', position: 'C', stat: 'pts', order: 'worst' }],
  ['how do the Lakers defend guards', { kind: 'matchups', position: 'G' }],
  ['teams that allow the most rebounds to forwards', { kind: 'matchups', position: 'F', stat: 'reb', order: 'worst' }],
  ['has Anthony Edwards gone over 27.5 points lately', { kind: 'props', market: 'pts', line: 27.5 }],
  ['Jokic rebounds line tonight', { kind: 'props', market: 'reb' }],
  ['how often does Haliburton hit over 9.5 assists', { kind: 'props', market: 'ast', line: 9.5 }],
  ['Luka PRA over 50.5 last 10', { kind: 'props', market: 'pra', line: 50.5 }],
  ['Knicks record', { kind: 'standings' }],
  ['who finished first in the West in 2019-20', { kind: 'standings', season: '2019-20' }],
  ['who won Celtics Heat last game', { kind: 'game', opponent: /heat/i }],
  ['Lakers score on 2026-01-15', { kind: 'game', date: '2026-01-15' }],
  ['who won Knicks Spurs in the Finals', { kind: 'series' }],
  ['who won the 2016 Finals', { kind: 'series', season: '2015-16' }],
  ['did the Warriors make the playoffs last season', { kind: 'series', season: /^(2025-26|)$/ }],
  ['who will win the championship', { kind: 'unsupported' }],
  ['should I bet the over on Tatum', { kind: 'unsupported' }],
  ['best NFL quarterback', { kind: 'unsupported' }],
];

const llm = createLlm();
if (!llm.configured) { console.error('ANTHROPIC_API_KEY is not set (repo-root .env)'); process.exit(1); }
// Preseason context (Oct 1, 2026: 2026-27 not started) — "last season" = 2025-26, the season that just ended.
const system = systemPrompt({ today: '2026-10-01', currentSeason: '2026-27', latestSeason: '2025-26', seasonInProgress: false });
let pass = 0, tokens = 0;
for (const [q, want] of CASES) {
  let plan, err;
  try { const out = await llm.plan({ system, tool: PLAN_TOOL, question: q }); plan = normalizePlan(out.input); tokens += (out.usage?.input_tokens ?? 0) + (out.usage?.output_tokens ?? 0); }
  catch (e) { err = e.message; }
  const bad = err ? [err] : Object.entries(want).filter(([k, v]) => (v instanceof RegExp ? !v.test(String(plan[k] ?? '')) : plan[k] !== v)).map(([k, v]) => `${k}: want ${v}, got ${plan[k]}`);
  if (!bad.length) pass++;
  console.log(`${bad.length ? '✗' : '✓'} ${q}${bad.length ? `\n    ${bad.join('; ')}\n    plan: ${JSON.stringify(plan)}` : ''}`);
}
console.log(`\n${pass}/${CASES.length} passed · model ${llm.model} · ~${tokens} tokens`);
if (pass / CASES.length < 0.9) process.exitCode = 1;
