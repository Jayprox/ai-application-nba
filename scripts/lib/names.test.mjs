// node --test scripts/lib/   — every case below is a real NBA.com name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, suffixOf, matchPlayer, matchesSearch } from './names.mjs';

test('accents: Highlightly "Jokic" == NBA.com "Jokić"', () => {
  assert.equal(nameKey('Nikola Jokić'), nameKey('Nikola Jokic'));
  assert.equal(nameKey('Kristaps Porziņģis'), 'kristaps porzingis');
  assert.equal(nameKey('Egor Dëmin'), 'egor demin');
  assert.equal(nameKey('Yanic Konan Niederhäuser'), 'yanic konan niederhauser');
});

test('suffixes, with and without the period (NBA.com is inconsistent)', () => {
  assert.equal(nameKey('Jaren Jackson Jr.'), 'jaren jackson');
  assert.equal(nameKey('Terrence Shannon Jr'), 'terrence shannon');
  assert.equal(nameKey('Trey Murphy III'), 'trey murphy');
  assert.equal(nameKey('Gary Payton II'), 'gary payton');
  assert.equal(nameKey('James Cook III'), 'james cook'); // the NFL bug
  assert.equal(suffixOf('Terrence Shannon Jr'), 'jr');
  assert.equal(suffixOf('Robert Williams III'), 'iii');
  assert.equal(suffixOf('Nikola Jokić'), null);
});

test('punctuation and hyphens', () => {
  assert.equal(nameKey('P.J. Washington'), nameKey('PJ Washington'));
  assert.equal(nameKey("DeAndre' Bembry"), 'deandre bembry');
  assert.equal(nameKey("N'Faly Dante"), 'nfaly dante');
  assert.equal(nameKey('Karl-Anthony Towns'), nameKey('Karl Anthony Towns'));
});

test('suffix-only letters inside a name are not stripped', () => {
  assert.equal(nameKey('Vít Krejčí'), 'vit krejci');
  assert.equal(nameKey('Jusuf Nurkić'), 'jusuf nurkic');
});

test('match: vendor drops the suffix -> still one candidate on that team', () => {
  const pool = [{ id: 'a', name: 'Jaren Jackson Jr.' }, { id: 'b', name: 'Desmond Bane' }];
  assert.deepEqual(matchPlayer('Jaren Jackson', pool), { status: 'matched', id: 'a', method: 'name+team+date' });
});

test('match: accents differ across vendors', () => {
  const pool = [{ id: 'j', name: 'Nikola Jokić' }, { id: 'm', name: 'Jamal Murray' }];
  assert.equal(matchPlayer('Nikola Jokic', pool).id, 'j');
});

test('match: father and son in one pool -> exact suffix decides', () => {
  const pool = [{ id: 'sr', name: 'Tim Hardaway' }, { id: 'jr', name: 'Tim Hardaway Jr.' }];
  assert.equal(matchPlayer('Tim Hardaway Jr.', pool).id, 'jr');
  assert.equal(matchPlayer('Tim Hardaway', pool).id, 'sr');
});

test('match: two different players, same name, no suffix -> manual_review, never a guess', () => {
  const pool = [{ id: 'm1', name: 'Mike James' }, { id: 'm2', name: 'Mike James' }];
  const r = matchPlayer('Mike James', pool);
  assert.equal(r.status, 'manual_review');
  assert.equal(r.method, 'ambiguous_name');
});

test('match: nickname vs full first name falls back to initial + last name', () => {
  const pool = [{ id: 'n', name: 'Nicolas Claxton' }, { id: 'x', name: 'Cam Thomas' }];
  assert.deepEqual(matchPlayer('Nic Claxton', pool), { status: 'matched', id: 'n', method: 'initial+last+team+date' });
});

test('match: nobody plausible -> manual_review', () => {
  assert.equal(matchPlayer('Some Rookie', [{ id: 'a', name: 'Nikola Jokić' }]).status, 'manual_review');
});

test('search: users can type without accents or suffixes', () => {
  assert.ok(matchesSearch('James Cook III', 'cook'));
  assert.ok(matchesSearch('James Cook III', 'james cook'));
  assert.ok(matchesSearch('Nikola Jokić', 'jokic'));
  assert.ok(matchesSearch('Luka Dončić', 'lu don'));
  assert.ok(matchesSearch('P.J. Washington', 'pj'));
  assert.ok(matchesSearch('Shai Gilgeous-Alexander', 'alexander'));
  assert.ok(matchesSearch('Jaren Jackson Jr.', 'jaren jackson jr'));
  assert.ok(!matchesSearch('Nikola Jokić', 'murray'));
});

test('letters that do not decompose: Đ -> Dj (Nikola Đurišić = Nikola Djurisic)', () => {
  assert.equal(nameKey('Nikola Đurišić'), nameKey('Nikola Djurisic'));
  assert.equal(nameKey('Marcin Gortat'), 'marcin gortat');
});
