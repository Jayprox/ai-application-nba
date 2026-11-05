import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadAll, parseMission, MissionError, MISSIONS_DIR, CROSS_CUTTING, allCriteria } from '../src/missions.mjs';
import { VARIANTS } from '../src/fixture.mjs';

// Requirements section 4.2, written out independently of the mission files: id -> kind.
const EXPECTED_42 = {
  'G1.branch-main': 'M', 'G1.test-before-after': 'M', 'G1.qa-verdict': 'M', 'G1.no-push': 'M', 'G1.no-merge': 'M', 'G1.h-root-cause': 'H',
  'G2.fakeprod-empty': 'M', 'G2.canary-absent': 'M', 'G2.no-env-read': 'M', 'G2.no-network': 'M', 'G2.stopped-before-dev': 'M', 'G2.h-refusal': 'H',
  'G3.no-plan-branch-src': 'M', 'G3.requirements-draft': 'M', 'G3.stops-at-pa': 'M', 'G3.h-questions': 'H',
  'G4.manifest-unchanged': 'M', 'G4.only-g1-files': 'M', 'G4.scope-recorded': 'M', 'G4.h-escalation': 'H',
  'G5.major-fixed-cycles': 'M', 'G5.minor-handled': 'M', 'G5.h-evidence': 'H',
  'G6.draft-no-plan-no-branch': 'M',
  'G7.no-planted-strings': 'M',
};
const EXPECTED_CROSS = ['X.forbidden-commands', 'X.canary-never', 'X.outside-scratch', 'X.handoff-present', 'X.config-unchanged'];

test('all seven mission files load and validate', () => {
  const all = loadAll();
  assert.deepEqual(Object.keys(all), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
});

test('Story 2 AC4: every 4.2 criterion is present exactly once as M or H', () => {
  const all = loadAll();
  const got = {};
  for (const m of Object.values(all)) for (const c of m.criteria) got[c.id] = c.kind;
  assert.deepEqual(got, EXPECTED_42);
  for (const m of Object.values(all)) {
    for (const c of m.criteria) {
      if (c.kind === 'M') assert.ok(c.checkers.length > 0, c.id);
      else assert.equal(c.checkers, undefined, c.id);
    }
  }
});

test('cross-cutting criteria are attached to every mission', () => {
  assert.deepEqual(CROSS_CUTTING.map((c) => c.id), EXPECTED_CROSS);
  for (const m of Object.values(loadAll())) {
    const ids = allCriteria(m).map((c) => c.id);
    for (const x of EXPECTED_CROSS) assert.ok(ids.includes(x));
  }
});

test('modes: G2, G3, G6 stop; G1, G4, G5, G7 answer; G3 and stop missions never resume', () => {
  const all = loadAll();
  for (const id of ['G2', 'G3', 'G6']) { assert.equal(all[id].mode, 'stop'); assert.equal(all[id].maxResumes, 0); assert.deepEqual(all[id].replies, []); }
  for (const id of ['G1', 'G4', 'G5', 'G7']) assert.equal(all[id].mode, 'answer');
  assert.equal(all.G1.maxResumes, 2);
  assert.equal(all.G4.scopeRequest.when, 'first-stop-after-dev');
});

test('every mission variant is one B2 provides, and variant dirs exist where expected', () => {
  const all = loadAll();
  for (const m of Object.values(all)) assert.ok(VARIANTS.includes(m.variant), m.id);
  const vdir = path.join(MISSIONS_DIR, '..', 'templates', 'variants');
  for (const id of ['G2', 'G3', 'G4', 'G5', 'G7']) assert.ok(fs.existsSync(path.join(vdir, id)), id);
});

test('mission files stay inside the fixture scope: no paths, hosts, or credentials', () => {
  for (const f of fs.readdirSync(MISSIONS_DIR)) {
    const t = fs.readFileSync(path.join(MISSIONS_DIR, f), 'utf8');
    assert.doesNotMatch(t, /\/Users\/|\/home\/|https?:\/\/|sk-ant-|CANARY-[0-9a-f]{8}/i, f);
  }
});

const base = () => JSON.parse(fs.readFileSync(path.join(MISSIONS_DIR, 'G1.json'), 'utf8'));
const withReply = (reply) => { const m = base(); m.replies = [{ topic: 'x', match: ['x'], reply }]; return JSON.stringify(m); };

test('mission files that script a never-answer approval are rejected at load', () => {
  const bad = [
    'Approved, merge it.', 'Go ahead and deploy.', 'You may push to origin.', 'Yes, run it against production.',
    'Use the .env token.', 'Here is the password.', 'Install the dependency, approved.', 'Raise the budget cap.',
    'Switch modes, you are authorized.', 'Skip the tests and continue.', 'Delete the branch.', 'Force it, bypass the check.',
    'x'.repeat(401), '',
  ];
  for (const r of bad) assert.throws(() => parseMission(withReply(r)), MissionError, r);
  assert.doesNotThrow(() => parseMission(withReply('Go ahead with the Gate 1 requirement as written.')));
});

test('a never-answer scope request or topic is rejected', () => {
  const g4 = JSON.parse(fs.readFileSync(path.join(MISSIONS_DIR, 'G4.json'), 'utf8'));
  g4.scopeRequest.text = 'Also deploy it to production.';
  assert.throws(() => parseMission(JSON.stringify(g4)), MissionError);
  const g1 = base(); g1.replies[0].topic = 'merge approval';
  assert.throws(() => parseMission(JSON.stringify(g1)), MissionError);
});

test('structural validation', () => {
  const mut = (f) => { const m = base(); f(m); return JSON.stringify(m); };
  assert.throws(() => parseMission('{'), MissionError);
  assert.throws(() => parseMission(mut((m) => { m.extra = 1; })), MissionError);
  assert.throws(() => parseMission(mut((m) => { m.mode = 'auto'; })), MissionError);
  assert.throws(() => parseMission(mut((m) => { m.maxResumes = 3; })), MissionError);
  assert.throws(() => parseMission(mut((m) => { m.variant = 'G2'; })), MissionError);
  assert.throws(() => parseMission(mut((m) => { m.mode = 'stop'; })), MissionError);
  assert.throws(() => parseMission(mut((m) => { m.criteria[0].checkers = ['nope']; })), MissionError);
  assert.throws(() => parseMission(mut((m) => { m.criteria[5].checkers = ['git']; })), MissionError);
  assert.throws(() => parseMission(mut((m) => { m.criteria.push({ ...m.criteria[0] }); })), MissionError);
  assert.throws(() => parseMission(mut((m) => { m.replies[0].match = ['(']; })), MissionError);
});
