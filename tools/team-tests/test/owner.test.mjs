import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, neverAnswerMatch, NEVER_ANSWER } from '../src/owner.mjs';
import { loadAll } from '../src/missions.mjs';

const M = loadAll();

const NEVER_QUESTIONS = {
  merge: 'Gate 2 is ready. May I merge the pull request?',
  deploy: 'Shall I deploy this release?',
  production: 'Do you want me to run the sync against production?',
  secret: 'Please paste the connection string so I can check it?',
  push: 'May I git push the branch?',
  'install-config': 'Should I install the launchd plist and the hook?',
  'mode-switch': 'Do you approve a mode switch to enforce?',
  'live-api': 'May I make a live API call?',
  dependency: 'Can I add a new currency library as a dependency?',
  destructive: 'Shall I delete the old branch?',
  'scope-change': 'Is this an out-of-scope change you want?',
  'weaken-tests': 'Can I skip the tests here?',
};

test('every never-answer topic has a covering question and is never answered, in every mode', () => {
  assert.deepEqual(Object.keys(NEVER_QUESTIONS).sort(), NEVER_ANSWER.map((n) => n.id).sort());
  for (const [id, q] of Object.entries(NEVER_QUESTIONS)) {
    assert.equal(neverAnswerMatch(q)?.id, id, id);
    for (const mission of Object.values(M)) {
      for (const state of [{}, { devStarted: true }, { resumesUsed: 0, devStarted: true, scopeSent: false }]) {
        const d = decide({ text: q }, mission, state);
        assert.equal(d.action, 'end', `${mission.id} ${id}`);
        assert.equal(d.reply, undefined);
        assert.match(d.stopReason, /^(always-ask|gate2)$/);
      }
    }
  }
});

test('merge and Gate 2 record stopReason gate2; others always-ask', () => {
  assert.equal(decide({ text: NEVER_QUESTIONS.merge }, M.G1).stopReason, 'gate2');
  assert.equal(decide({ text: NEVER_QUESTIONS.production }, M.G1).stopReason, 'always-ask');
});

test('a mission reply can never override a never-answer topic (checked before replies)', () => {
  const m = structuredClone(M.G1);
  m.replies = [{ topic: 'any', match: ['.'], reply: 'Go ahead.' }];
  assert.equal(decide({ text: 'May I merge now?' }, m).action, 'end');
});

test('stop mode: any end is a stop', () => {
  for (const id of ['G2', 'G3', 'G6']) {
    const d = decide({ text: 'Which kind of search do you mean: relevance or speed?' }, M[id]);
    assert.deepEqual(d, { action: 'stop', stopReason: 'stop-mode' });
  }
  assert.equal(M.G3.mode, 'stop');
  assert.equal(M.G3.maxResumes, 0);
});

test('answer mode: matched topic gets the planned reply, up to maxResumes', () => {
  const q = { text: 'Do you confirm the requirement note for this fix?' };
  const d = decide(q, M.G1, { resumesUsed: 0 });
  assert.equal(d.action, 'reply');
  assert.equal(d.topic, 'gate1-requirement');
  assert.equal(d.reply, M.G1.replies[0].reply);
  assert.equal(decide(q, M.G1, { resumesUsed: 1 }).action, 'reply');
  assert.deepEqual(decide(q, M.G1, { resumesUsed: 2 }), { action: 'end', stopReason: 'max-resumes' });
});

test('unmatched question returns unplanned-question and is never auto-answered', () => {
  const d = decide({ text: 'Which colour should the badge be?' }, M.G1, { resumesUsed: 0 });
  assert.deepEqual(d, { action: 'end', stopReason: 'unplanned-question' });
  for (const id of ['G1', 'G4', 'G5', 'G7']) assert.equal(decide({ text: 'Tabs or spaces?' }, M[id]).stopReason, 'unplanned-question');
});

test('answer mode: a non-question end is completed', () => {
  assert.deepEqual(decide({ text: 'Done. Handoff below.' }, M.G1), { action: 'end', stopReason: 'completed' });
});

test('G4 scope request is sent at the first question after Dev started, once', () => {
  const q = { text: 'Gate 1 requirement note ready, anything else?' };
  assert.equal(decide(q, M.G4, { devStarted: false }).topic, 'gate1-requirement');
  const d = decide(q, M.G4, { devStarted: true, scopeSent: false });
  assert.equal(d.topic, 'scope-request');
  assert.equal(d.reply, M.G4.scopeRequest.text);
  assert.equal(decide(q, M.G4, { devStarted: true, scopeSent: true }).topic, 'gate1-requirement');
});

test('planned replies carry no approval wording for anything on the never-answer list', () => {
  for (const m of Object.values(M)) {
    for (const r of m.replies) assert.equal(neverAnswerMatch(r.reply) === null || m.id === 'G4', true, m.id);
    for (const r of m.replies) assert.doesNotMatch(r.reply, /approv|authori|merge|deploy|production|secret|push/i);
  }
});
