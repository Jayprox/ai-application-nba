// Natural-language search. The model is faked here (a fixed plan), so these
// tests cover everything we own: plan validation, name resolution, the API
// calls, and that the sentence is built from the API's numbers. The live
// model is checked separately by `npm run ask:eval` (real questions).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, playerId } from './helpers.js';
import { normalizePlan } from '../src/ask/planner.js';
import { resolvePlayer, resolveTeam } from '../src/ask/resolve.js';
import { appLink, chips, filterPhrase, firstRequest, summarize } from '../src/ask/answer.js';

let next = null;
const fakeLlm = { configured: true, model: 'fake', calls: 0, async plan() { this.calls++; return { input: next } }, };
let s, lebron;
before(async () => { s = await startServer({ llm: fakeLlm }); lebron = await playerId(s.db, 'LeBron James'); });
after(() => s.close());
const ask = (body) => s.api('POST', '/ask', body);

test('plans are validated: bad values dropped, not guessed; missing subject -> a question back', () => {
  assert.deepEqual(normalizePlan({ kind: 'player_stats', player: 'Jokic', b2b: 2, venue: 'road', rest: 7, season: '2024' }), { kind: 'player_stats', player: 'Jokic', season: '2023-24', b2b: 2 });
  assert.deepEqual(normalizePlan({ kind: 'player_stats' }), { kind: 'unsupported', reason: 'which player?' });
  assert.deepEqual(normalizePlan({ kind: 'nonsense' }), { kind: 'unsupported' });
  assert.deepEqual(normalizePlan({ kind: 'props', player: 'Tatum', line: 26.4 }), { kind: 'props', player: 'Tatum', line: 26.5, market: 'pts', scope: 'last10' });
  assert.deepEqual(normalizePlan({ kind: 'matchups', stat: 'pra' }), { kind: 'matchups', stat: 'pra', position: 'G' });
  assert.equal(normalizePlan({ kind: 'leaders', stat: 'ts_pct' }).stat, 'pts', 'leaders only take leaderboard stats');
});

test('player names: accents, nicknames, last names; the obvious active star wins, real ties are asked', () => {
  const pool = [
    { id: 'steph', full_name: 'Stephen Curry', is_active: true, games: 1000 }, { id: 'seth', full_name: 'Seth Curry', is_active: true, games: 300 },
    { id: 'dell', full_name: 'Dell Curry', is_active: false, games: 50 }, { id: 'jokic', full_name: 'Nikola Jokić', is_active: true, games: 800 },
    { id: 'sga', full_name: 'Shai Gilgeous-Alexander', is_active: true, games: 500 }, { id: 'jjj', full_name: 'Jaren Jackson Jr.', is_active: true, games: 450 },
    { id: 'jw1', full_name: 'Jalen Williams', is_active: true, games: 250 }, { id: 'jw2', full_name: 'Jaylin Williams', is_active: true, games: 200 },
  ];
  assert.equal(resolvePlayer('Curry', pool).id, 'steph');
  assert.equal(resolvePlayer('seth curry', pool).id, 'seth');
  assert.equal(resolvePlayer('Jokic', pool).id, 'jokic');
  assert.equal(resolvePlayer('SGA', pool).id, 'sga');
  assert.equal(resolvePlayer('Jaren Jackson', pool).id, 'jjj');
  assert.deepEqual(resolvePlayer('Williams', pool).ambiguous.map((p) => p.id), ['jw1', 'jw2']);
  assert.ok(resolvePlayer('Michael Jordan', pool).none);
});

test('team names: abbreviations, nicknames, cities; "LA" is asked, not guessed', () => {
  const teams = [
    { id: 20, abbreviation: 'NYK', city: 'New York', name: 'Knicks', full_name: 'New York Knicks' }, { id: 23, abbreviation: 'PHI', city: 'Philadelphia', name: '76ers', full_name: 'Philadelphia 76ers' },
    { id: 13, abbreviation: 'LAL', city: 'Los Angeles', name: 'Lakers', full_name: 'Los Angeles Lakers' }, { id: 12, abbreviation: 'LAC', city: 'LA', name: 'Clippers', full_name: 'LA Clippers' },
    { id: 10, abbreviation: 'GSW', city: 'Golden State', name: 'Warriors', full_name: 'Golden State Warriors' },
  ];
  assert.equal(resolveTeam('Knicks', teams).id, 20);
  assert.equal(resolveTeam('nyk', teams).id, 20);
  assert.equal(resolveTeam('Sixers', teams).id, 23);
  assert.equal(resolveTeam('the Warriors', teams).id, 10);
  assert.equal(resolveTeam('Golden State', teams).id, 10);
  assert.equal(resolveTeam('Los Angeles Clippers', teams).id, 12);
  assert.deepEqual(resolveTeam('LA', teams).ambiguous.map((t) => t.id).sort(), [12, 13]);
});

test('plan -> API request, chips, phrase and link', () => {
  const ctx = { latestSeason: '2025-26' };
  const ids = { player: { id: 'p1', name: 'X' }, team: { id: 7, abbr: 'BOS', name: 'Boston Celtics' } };
  const p = { kind: 'player_stats', player: 'X', b2b: 2, venue: 'away', rest: '0' };
  assert.deepEqual(firstRequest(p, ids, ctx).body, { entity: 'player', id: 'p1', scope: 'season', season_type: 'regular', season: '2025-26', splits: { venue: 'away', player_b2b: 2, player_rest: 0 } });
  assert.deepEqual(firstRequest({ ...p, rest_by: 'team' }, ids, ctx).body.splits, { venue: 'away', b2b: 2, rest: 0 });
  assert.equal(firstRequest({ ...p, scope: 'career' }, ids, ctx).body.season, undefined);
  assert.equal(firstRequest({ kind: 'leaders', stat: 'stl', season_type: 'cup' }, ids, ctx).body.season_type, 'regular');
  assert.equal(filterPhrase(p), "on the road on the second night of a back-to-back on 0 days' rest");
  assert.deepEqual(chips(p, ctx).map((c) => c.label), ['2025-26 (latest)', 'Away', 'Back-to-back night 2', '0 days rest']);
  assert.equal(appLink(p, ids, ctx), '/players/p1?season=2025-26&venue=away&b2b=2&rest=0');
  assert.equal(appLink({ kind: 'matchups', position: 'C', stat: 'reb', order: 'worst' }, ids, ctx), '/rankings?view=matchups&season=2025-26&pos=C&sort=reb');
  assert.equal(firstRequest({ kind: 'game', team: 'BOS', date: '2026-01-15' }, ids, ctx).body.season, '2025-26', 'a dated game uses that date\'s season');
});

test('sentences are templates over the API numbers', () => {
  const ctx = { latestSeason: '2025-26' };
  const q = { subject: { name: 'Nikola Jokić' }, meta: { sample_size: 9, record: '6-3' }, data: { pts: 29.1, reb: 12.4, ast: 10.2, ts_pct: 0.671 } };
  const ids = { player: { id: 'j', name: 'Nikola Jokić' } };
  assert.equal(summarize({ kind: 'player_stats', b2b: 2 }, ids, { main: q }, ctx).sentence,
    'Nikola Jokić averaged 29.1 points, 12.4 rebounds and 10.2 assists in 9 2025-26 regular season games on the second night of a back-to-back (his team went 6-3).');
  assert.equal(summarize({ kind: 'player_stats', stat: 'ts_pct', scope: 'last10' }, ids, { main: q }, ctx).sentence,
    'Nikola Jokić had a true shooting % of .671 over his last 9 games (2025-26 regular season; his team went 6-3).');
  assert.equal(summarize({ kind: 'player_stats' }, ids, { main: { ...q, meta: { sample_size: 0 } } }, ctx).sentence, 'No 2025-26 regular season games for Nikola Jokić.');
  const props = summarize({ kind: 'props', market: 'pts', scope: 'last10' }, { player: { id: 't', name: 'Jayson Tatum' } },
    { main: { data: { upcoming: { game: { away: 'BOS', home: 'NYK', date: '2026-10-21' }, lines: [{ market: 'pts', line: 26.5 }] }, record: {} } }, hits: { props: { pts: { line: 26.5, over: 6, under: 4, push: 0, games: 10 } } } }, ctx);
  assert.equal(props.sentence, 'DraftKings has Jayson Tatum at 26.5 points for BOS @ NYK (2026-10-21). He went over 26.5 in 6 of his last 10 games.');
  assert.match(summarize({ kind: 'unsupported', reason: 'predictions' }, {}, {}, ctx).sentence, /only answer NBA stats/);
  assert.deepEqual(chips({ kind: 'unsupported' }, ctx), [], 'no filter chips on a refusal');
  const noDk = summarize({ kind: 'props', market: 'pts', scope: 'last10', line: 27.5 }, { player: { id: 'e', name: 'Anthony Edwards' } },
    { main: { data: { upcoming: null, record: {} } }, hits: { props: { pts: { line: 27.5, over: 4, under: 6, push: 0, games: 10 } } } }, ctx);
  assert.equal(noDk.sentence, 'Anthony Edwards went over 27.5 points in 4 of his last 10 games.');
  const lead = summarize({ kind: 'leaders', stat: 'stl' }, {}, { main: { data: [{ full_name: 'Dyson Daniels', team: 'ATL', value: 2, gp: 76 }], meta: {} } }, ctx);
  assert.equal(lead.sentence, 'Dyson Daniels (ATL) led the 2025-26 regular season in steals at 2.0 per game over 76 games.');
  const q2 = { ...q, data: { ...q.data, usg_pct: 0.283 } };
  assert.equal(summarize({ kind: 'player_stats', stat: 'usg_pct' }, ids, { main: q2 }, ctx).sentence,
    'Nikola Jokić had a usage rate of 28.3% in 9 2025-26 regular season games (his team went 6-3).');
  const usgLead = summarize({ kind: 'leaders', stat: 'usg_pct' }, {}, { main: { data: [{ full_name: 'Luka Dončić', team: 'LAL', value: 0.351, gp: 64 }], meta: {} } }, ctx);
  assert.equal(usgLead.sentence, 'Luka Dončić (LAL) led the 2025-26 regular season in usage rate at 35.1% (est.) over 64 games.');
  assert.equal(normalizePlan({ kind: 'leaders', stat: 'usg_pct' }).stat, 'usg_pct', 'usage is a leaderboard stat');
});

// ---- end to end (fake model, real API + data) ------------------------------------------------
test('POST /ask: question -> plan -> real numbers (LeBron 2003-04 = NBA.com 20.9 / 5.5 / 5.9)', async () => {
  next = { kind: 'player_stats', player: 'LeBron', season: '2003-04' };
  const r = await ask({ q: 'how did lebron do his rookie year' });
  assert.equal(r.status, 200);
  assert.equal(r.body.subject.player.id, lebron);
  assert.match(r.body.sentence, /^LeBron James averaged 20\.9 points, 5\.5 rebounds and 5\.9 assists in 79 2003-04 regular season games/);
  assert.equal(r.body.view.type, 'stats');
  assert.equal(r.body.link, `/players/${lebron}?season=2003-04`);
  // Same question again: the plan comes from the cache, no second model call.
  const before = fakeLlm.calls;
  const again = await ask({ q: 'How did LeBron do his   rookie year' });
  assert.equal(again.body.cached, true);
  assert.equal(fakeLlm.calls, before);
});

test('POST /ask {plan}: removing a chip re-runs without a model call; splits reach the API', async () => {
  const before = fakeLlm.calls;
  const road = await ask({ plan: { kind: 'player_stats', player: 'LeBron James', season: '2003-04', venue: 'away' } });
  assert.match(road.body.sentence, /in 41 2003-04 regular season games on the road/);      // NBA.com: road 41 GP
  assert.match(road.body.sentence, /20\.6 points/);
  const all = await ask({ plan: { ...road.body.plan, venue: undefined } });
  assert.match(all.body.sentence, /in 79 /);
  assert.equal(fakeLlm.calls, before);
});

test('POST /ask: ambiguous team -> choices; unsupported -> says so; bad input -> 400', async () => {
  next = { kind: 'team_stats', team: 'LA' };
  const la = await ask({ q: 'how is LA doing' });
  assert.equal(la.body.view.type, 'clarify');
  assert.equal(la.body.clarify.field, 'team');
  assert.ok(la.body.clarify.options.length >= 2);
  next = { kind: 'unsupported', reason: 'predictions' };
  assert.match((await ask({ q: 'who will win the title' })).body.sentence, /only answer NBA stats/);
  assert.equal((await ask({ q: 'x' })).status, 400);
  assert.equal((await ask({ q: 'y'.repeat(301) })).status, 400);
});

test('POST /ask: a game result is found in the team game log', async () => {
  next = { kind: 'game', team: 'Cavaliers', date: '2004-04-14' };
  const r = await ask({ q: 'cavs game april 14 2004' });
  assert.equal(r.status, 200);
  assert.match(r.body.sentence, /(CLE beat NYK|NYK beat CLE) \d+-\d+ on 2004-04-14/);
  assert.match(r.body.link, /^\/games\//);
});

test('series: who won, from the bracket; a team\'s last series when it lost', () => {
  const ctx = { latestSeason: '2025-26' };
  const b = { data: [
    { round: 'finals', conference: null, higher_id: 20, higher_abbr: 'NYK', lower_id: 27, lower_abbr: 'SAS', higher_wins: 4, lower_wins: 1, winner_team_id: 20, best_of: 7 },
    { round: 'conf_finals', conference: 'West', higher_id: 21, higher_abbr: 'OKC', lower_id: 27, lower_abbr: 'SAS', higher_wins: 2, lower_wins: 4, winner_team_id: 27, best_of: 7 },
    { round: 'play_in', conference: 'West', higher_id: 24, higher_abbr: 'PHX', lower_id: 10, lower_abbr: 'GSW', higher_wins: 1, lower_wins: 0, winner_team_id: 24, best_of: 1 },
  ] };
  assert.equal(summarize({ kind: 'series' }, {}, { main: b }, ctx).sentence, 'NYK beat SAS 4-1 in the 2025-26 NBA Finals.');
  assert.equal(summarize({ kind: 'series', team: 'OKC' }, { team: { id: 21, abbr: 'OKC', name: 'Oklahoma City Thunder' } }, { main: b }, ctx).sentence,
    "SAS beat OKC 4-2 in the 2025-26 conference finals (West), the Oklahoma City Thunder's last series that postseason.");
  assert.equal(summarize({ kind: 'series', team: 'GSW' }, { team: { id: 10, abbr: 'GSW', name: 'Golden State Warriors' } }, { main: b }, ctx).sentence,
    "PHX beat GSW in the 2025-26 play-in (West), the Golden State Warriors' last series that postseason.");
  assert.equal(summarize({ kind: 'series', team: 'BOS' }, { team: { id: 2, abbr: 'BOS', name: 'Boston Celtics' } }, { main: b }, ctx).sentence, "The Boston Celtics didn't play in the 2025-26 postseason.");
});

test('POST /ask without a configured model: 503 with a clear message (plans still work)', async () => {
  const s2 = await startServer({ llm: { configured: false, model: 'none', plan: async () => { throw new Error('no'); } } });
  try {
    assert.equal((await s2.api('POST', '/ask', { q: 'something never asked before 123' })).status, 503);
    assert.equal((await s2.api('POST', '/ask', { plan: { kind: 'leaders', stat: 'pts', season: '2003-04' } })).status, 200);
  } finally { await s2.close(); }
});
