import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDays, etDate, starterIds, statLine, statusOf, teamMinutes, teamTotals, totalScore } from '../src/map.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

test('status: Highlightly state -> games.status', () => {
  assert.equal(statusOf({ description: 'Finished' }), 'final');
  assert.equal(statusOf({ description: 'Scheduled' }), 'scheduled');
  assert.equal(statusOf({ description: '3rd quarter' }), 'live');
  assert.equal(statusOf({ description: 'Half time' }), 'live');
  assert.equal(statusOf({ description: 'Postponed' }), 'postponed');
  assert.equal(statusOf({ description: 'Cancelled' }), 'cancelled');
});

test('scores: quarters (+ overtimes) summed; MEM 101 @ HOU 132 on 2026-04-12', () => {
  const m = fx('matches_2026-04-12').data.find((x) => x.id === 1439038);
  assert.equal(totalScore(m.state.score.homeTeam), 132);
  assert.equal(totalScore(m.state.score.awayTeam), 101);
  assert.equal(totalScore([]), null);
  assert.equal(teamMinutes(4), 240);
  assert.equal(teamMinutes(6), 290);   // double overtime
});

test('box score lines: 17 stats mapped, DNPs flagged (NBA.com omits them)', () => {
  const [hou, mem] = fx('box-score_1439038');
  const eason = statLine(hou.boxScores.find((b) => b.player.name === 'Tari Eason'));
  assert.deepEqual(eason, { dnp: false, stats: { minutes: 24, pts: 20, fgm: 8, fga: 17, fg3m: 1, fg3a: 5, ftm: 3, fta: 3, oreb: eason.stats.oreb, dreb: eason.stats.dreb, reb: 8, ast: 3, stl: 0, blk: 0, tov: 2, pf: eason.stats.pf, plus_minus: 20 } });
  assert.equal(eason.stats.pts, 2 * eason.stats.fgm + eason.stats.fg3m + eason.stats.ftm);
  assert.equal(statLine(hou.boxScores.find((b) => b.player.name === 'Amen Thompson')).dnp, true);
  assert.equal(mem.boxScores.filter((b) => statLine(b).dnp).length, 5);
  const tot = teamTotals(hou.boxScores.map(statLine), 4);
  assert.equal(tot.pts, 132);
  assert.equal(tot.reb, tot.oreb + tot.dreb);
  assert.equal(tot.minutes, 240);
});

test('starters come from /lineups isStarter === true', () => {
  const s = starterIds(fx('lineups_1439038'));
  assert.equal(s.size, 10);
  assert.ok(s.has('66498947'));   // Tari Eason
  assert.ok(!s.has('49202'));     // Jeff Green: isStarter null
});

test('dates: America/New_York calendar day (a 7:30 pm ET tip is the next UTC day)', () => {
  assert.equal(etDate(new Date('2026-04-13T00:30:00Z')), '2026-04-12');
  assert.equal(etDate(new Date('2026-04-13T05:00:00Z')), '2026-04-13');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
