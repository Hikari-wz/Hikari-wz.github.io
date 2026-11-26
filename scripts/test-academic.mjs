import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apportion, baselineAt, passesGap, recommend, stageAt, weeklyAllocation } from '../src/features/academic/allocation.ts';
import { inputsOf, reserveId } from '../src/features/academic/model.ts';
import { analysisInput, comparable, executionWeek, propose, reconcileUpdate, recordDecision, reviewOf, settle, targetAt } from '../src/features/academic/review.ts';
import { exportBackup, importBackup } from '../src/features/study/storage.ts';
import { localClock, monday, startOfDay } from '../src/features/study/time.ts';
import { academic, inputWeek, legacy, mondayAt, record, result, sharedExam, sunday, sundayFixture, tuesdayAt, wednesday } from './fixtures/academic.mjs';

const clock = (day, minute = 720) => ({ day, minute });
function baseline(data, term, day = inputWeek, minute = 720) {
  return baselineAt(inputsOf(data), term, clock(day, minute), data.academic.otherId);
}
const eq = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, [actual, expected].join(' != '));

test('T03/T04 old envelope migrates losslessly; full restore validates references and future versions', () => {
  for (const pause of [false, true]) for (const duplicate of [false, true]) {
    const old = legacy({ pause, duplicate });
    const raw = exportBackup(old);
    assert.equal(JSON.parse(raw).version, 1);
    const migrated = importBackup(raw);
    for (const key of ['settings', 'plans', 'sessions', 'timer', 'exams', 'reviews']) assert.deepEqual(migrated[key], old[key]);
    assert.deepEqual(migrated.subjects.slice(0, old.subjects.length).map(item => item.id), old.subjects.map(item => item.id));
    assert.equal(migrated.subjects.find(item => item.id === 'school-2').name, duplicate ? '程序设计' : 'C 语言');
    assert.equal(migrated.academic.aliases.length, duplicate ? 0 : 1);
    const full = exportBackup(migrated);
    assert.equal(JSON.parse(full).version, 2);
    assert.deepEqual(importBackup(full), migrated);
    assert.throws(() => importBackup(full.replace('"version": 2', '"version": 999')), /版本/);
    assert.throws(() => importBackup(full.slice(0, -2)), /JSON/);
    assert.throws(() => importBackup(full.replace('"minutes": 120', '"minutes": -120')), /无效/);
    assert.throws(() => importBackup(full.replace('"subjectId": "school-0"', '"subjectId": "bad"')), /无效/);
  }
});

test('T05/T07 civil dates, no division by zero, sample thresholds, two gaps and crowding', () => {
  const { data, term } = academic();
  const target = baseline(data, term).target;
  for (const minutes of [0, 29, 30, 119]) {
    data.sessions = minutes ? [record('s', 'school-0', minutes)] : [];
    assert.equal(weeklyAllocation(data, term, inputWeek, clock(inputWeek), target).total, minutes);
    assert.notEqual(recommend(data, term, clock(inputWeek), target).code, 'gap');
  }
  for (const [t, q, c] of [[120, 120, 19], [200, 120, 30]]) {
    data.sessions = [record('m', 'school-0', q-c), record('c', 'school-2', c)];
    if (t > q) data.sessions.push(record('o', data.academic.otherId, t-q));
    const { differences } = weeklyAllocation(data, term, inputWeek, clock(inputWeek), target);
    assert.equal(passesGap(differences['school-2'][0], t), t > q);
    assert.equal(passesGap(differences['school-2'][1], q), t === q);
    const pick = recommend(data, term, clock(inputWeek), target);
    assert.ok(pick.code !== 'gap' || pick.subjectId !== 'school-2');
  }
  data.sessions = [record('o', data.academic.otherId, 200), record('m', 'school-0', 1), record('independent', 'self-0', 120)];
  assert.equal(weeklyAllocation(data, term, inputWeek, clock(inputWeek), target).crowded, true);
  assert.notEqual(recommend(data, term, clock(inputWeek), target).code, 'gap');
  assert.ok(passesGap(15, 120) && passesGap(20, 400) && !passesGap(14.99, 120) && !passesGap(19.99, 400));
  const before = localClock(mondayAt - 60000, 'Asia/Shanghai');
  assert.equal(monday(before.day), inputWeek);
  assert.equal(monday(localClock(mondayAt, 'Asia/Shanghai').day), '2027-01-04');
  assert.equal(monday(localClock(mondayAt, 'America/New_York').day), inputWeek);
  assert.equal(startOfDay('2027-03-14', 'America/New_York'), Date.parse('2027-03-14T05:00:00Z'));
  term.from = '2026-12-31';
  data.sessions = [record('outside', 'school-0', 30), record('midnight', 'school-0', 40, '2027-01-01')];
  const stats = weeklyAllocation(data, term, inputWeek, clock('2027-01-03'), {});
  assert.equal(stats.minutes['@outside'], 30);
  assert.equal(stats.total, 70);
});

test('T06/T07 fixed calibration, largest remainders, modified actual shares and manual fallback', () => {
  const { data, term } = academic();
  const partial = baseline(data, term).target;
  for (const [id, expected] of [['school-0', 45], ['school-2',23], ['school-1',11]]) eq(partial[id], .97 * expected / 79);
  term.courses.forEach(course => { course.activation = 'on'; });
  const target = baseline(data, term).target;
  assert.deepEqual(apportion(target, 100),
    { 'school-0': 45, 'school-2': 23, 'school-1': 11, 'academic-history': 10, 'academic-health': 5, 'academic-intro': 3, [reserveId]: 3 });
  assert.equal(Object.values(apportion(target, 503)).reduce((sum, n) => sum + n, 0), 503);
  for (const [index, minutes] of [420, 60, 60, 30, 30].entries()) data.sessions.push(record('s-' + index, term.courses[index].subjectId, minutes));
  const first = weeklyAllocation(data, term, inputWeek, clock(inputWeek), target);
  eq(first.minutes['school-2'] / first.total, .10);
  eq(first.differences['school-2'][0], 78);
  assert.equal(recommend(data, term, clock(inputWeek), target).subjectId, 'school-2');
  data.sessions.push(record('more', 'school-2', 120));
  const second = weeklyAllocation(data, term, inputWeek, clock(inputWeek), target);
  eq(second.minutes['school-2'] / second.total, .25);
  assert.notEqual(recommend(data, term, clock(inputWeek), target).subjectId, 'school-2');
  term.manual = { ...target };
  term.courses[0].activation = 'off';
  assert.equal(baseline(data, term).target['school-0'], undefined);
  term.courses[0].activation = 'on';
  assert.equal(baseline(data, term).target, term.manual);
  term.courses.forEach(course => { course.credits = null; });
  assert.deepEqual(baseline(data, term).target, {});
});

test('T08/T09 mode windows, confirmed-only deadlines, checklist, stage isolation and tasks', () => {
  const { data, term } = academic();
  data.exams.push(sharedExam('academic-history', '2027-01-19'),
    sharedExam('academic-health', '2027-01-26', { id: 'health', end: '12:00' }));
  const active = (id, day, minute) => baseline(data, term, day, minute).courses.find(item => item.course.subjectId === id).active;
  assert.equal(active('academic-history', '2027-01-04'), false);
  assert.equal(active('academic-history', '2027-01-05'), true);
  assert.equal(active('academic-health', '2027-01-18'), false);
  assert.equal(active('academic-health', '2027-01-19'), true);
  assert.equal(active('academic-health', '2027-01-26', 719), true);
  assert.equal(active('academic-health', '2027-01-26', 720), false);
  const task = (id, days, patch = {}) => ({
    id, termId: term.id, subjectId: data.academic.otherId, examId: '', title: '合成任务-' + id, kind: 'assignment',
    certainty: 'confirmed', status: 'scheduled', day: '2027-01-' + days, time: '', prepare: '', required: false, ...patch,
  });
  data.academic.assessments.push(task('draft', '05', { certainty: 'tentative' }), task('real', '08'));
  const at = clock('2027-01-05');
  const take = () => recommend(data, term, at, baseline(data, term, at.day).target);
  assert.equal(take().evidenceId, 'real');
  term.override = 'vacation';
  assert.equal(take(), undefined);
  data.academic.assessments.at(-1).day = '2027-01-07';
  assert.equal(take().evidenceId, 'real');
  data.academic.assessments.at(-1).status = 'completed';
  assert.equal(take(), undefined);
  const en = term.courses.find(course => course.subjectId === 'school-1');
  data.academic.assessments.push(task('oral', '04', { subjectId: en.subjectId, kind: 'oral', status: 'completed', required: true }));
  assert.equal(active(en.subjectId, at.day), true);
  en.checklist = ['oral'];
  assert.equal(active(en.subjectId, at.day), false);
  data.academic.assessments.at(-1).status = 'cancelled';
  assert.equal(active(en.subjectId, at.day), true);
  for (const [stage, label] of [['normal', /章节/], ['prepare', /闭卷/], ['review', /考试范围/], ['sprint', /限时/]]) {
    term.override = stage;
    assert.equal(stageAt(inputsOf(data), term, at).stage, stage);
    assert.match(take().action, label);
  }
});

test('T10/T11 comparable results, exact trend threshold, unchanged effect from text and subjective feedback', () => {
  const { data, term } = sundayFixture();
  const first = propose(data, term, sunday, true);
  assert.ok(first);
  eq(first.after['school-0'] - first.before['school-0'], .02);
  data.academic.results.push(result('same-day', 'school-0', '2027-01-01', 100, { scope: 'other' }));
  assert.equal(comparable(data, term.id, 'school-0', '2027-01-03').pair[1].id, 'math-b');
  data.academic.results[0].note = 'synthetic free text';
  data.sessions[0].quality = '仍需继续学习';
  assert.equal(propose(data, term, sunday, true).fingerprint, first.fingerprint);
  data.academic.results.find(item => item.id === 'math-b').value = 66;
  assert.equal(comparable(data, term.id, 'school-0', '2027-01-03').trend, '提高');
  const noBudget = structuredClone(data);
  noBudget.plans = [];
  assert.equal(reviewOf(noBudget, term, inputWeek, sunday, true).budget, null);
  noBudget.academic.versions = [];
  assert.equal(reviewOf(noBudget, term, inputWeek, sunday, true).history, undefined);
  assert.equal(JSON.stringify(analysisInput(data, term, inputWeek, sunday)).includes('synthetic'), false);
  const mixed = result('mixed', 'school-0', '2027-01-01', 6, { metric: 'independent', total: 10, prompted: 2 });
  data.academic.results.push(mixed);
  assert.deepEqual(importBackup(exportBackup(data)).academic.results.at(-1), mixed);
  for (const [value, total, prompted] of [[0, 0, null], [11, 10, null], [6, 10, 5]]) {
    Object.assign(mixed, { value, total, prompted });
    assert.throws(() => importBackup(exportBackup(data)), /无效/);
  }
  Object.assign(mixed, { value: 0, total: 10, prompted: null });
  assert.equal(importBackup(exportBackup(data)).academic.results.at(-1).value, 0);
});

test('T12/T14 Sunday confirmation, Wednesday load settles Monday then pauses Tuesday; original evidence is immutable', () => {
  const { data, term } = sundayFixture();
  const proposal = propose(data, term, sunday, true);
  recordDecision(data, proposal, sunday);
  recordDecision(data, proposal, sunday);
  assert.equal(data.academic.adjustments.length, 1);
  assert.equal(data.academic.adjustments[0].state, 'pending');
  assert.equal(proposal.effectiveAt, mondayAt);
  settle(data, wednesday);
  const item = data.academic.adjustments[0];
  assert.equal(item.state, 'paused');
  assert.equal(item.appliedAt, mondayAt);
  assert.equal(item.endedAt, tuesdayAt);
  assert.equal(targetAt(data, term, mondayAt)['school-0'], item.proposal.after['school-0']);
  assert.equal(targetAt(data, term, wednesday)['academic-history'] > 0, true);
  data.academic.results = data.academic.results.filter(sample => sample.id !== 'math-a');
  assert.equal(item.proposal.evidence.pair[0].value, 61);
  assert.deepEqual(importBackup(exportBackup(data)), data);
});

test('T12 pending changes, Monday gates including cross-week paused timer, rejection and post-effect loss of basis', () => {
  const { data, term } = sundayFixture();
  const proposal = propose(data, term, sunday, true);
  recordDecision(data, proposal, sunday);
  const before = structuredClone(data);
  data.sessions[0].minutes++;
  reconcileUpdate(before, data, sunday + 1000);
  assert.equal(data.academic.adjustments[0].state, 'invalid');
  assert.throws(() => recordDecision(data, proposal, sunday + 1000), /过期/);
  const fresh = sundayFixture();
  const now = mondayAt + 60_000;
  assert.equal(executionWeek(fresh.data, term.id, now).week, '2027-01-04');
  for (const runningSince of [sunday, null]) {
    fresh.data.timer = { id: 'cross', subjectId: 'school-0', day: '2027-01-03', startedAt: sunday, elapsedMs: 1, runningSince };
    assert.equal(executionWeek(fresh.data, term.id, now).week, '2027-01-11');
  }
  fresh.data.timer = null;
  const newRecord = record('monday', 'school-0', 25, '2027-01-04');
  fresh.data.sessions.push(newRecord);
  assert.equal(executionWeek(fresh.data, term.id, now).week, '2027-01-11');
  fresh.data.sessions.pop();
  assert.equal(executionWeek(fresh.data, term.id, tuesdayAt).week, '2027-01-11');
  const immediate = propose(fresh.data, fresh.term, now);
  recordDecision(fresh.data, immediate, now, true);
  assert.equal(propose(fresh.data, fresh.term, now), undefined);
  assert.equal(fresh.data.academic.adjustments[0].appliedAt, null);
});

test('T07 same deficits prefer strengthening, elapsed days then stable ID; budget does not affect actual shares', () => {
  const { data, term } = academic();
  term.manual = { 'school-0': .33, 'school-1': .32, 'school-2': .32, [reserveId]: .03 };
  const on = clock('2027-01-03');
  data.sessions = [record('m', 'school-0', 120)];
  const target = baseline(data, term, on.day).target;
  const get = () => recommend(data, term, on, target);
  assert.equal(get().subjectId, 'school-1');
  term.courses[1].status = 'strengthen';
  assert.equal(get().subjectId, 'school-2');
  term.courses[1].status = 'normal';
  data.sessions.push(record('en-before', 'school-1', 30, '2026-12-27'));
  assert.equal(get().subjectId, 'school-2');
  const first = weeklyAllocation(data, term, inputWeek, on, target);
  data.plans.push({ ...sundayFixture().data.plans[0] });
  const second = weeklyAllocation(data, term, inputWeek, on, target);
  assert.equal(first.total, second.total);
  assert.deepEqual(first.differences, second.differences);
  assert.notEqual(first.budget, second.budget);
});

test('T10/T11 independent evidence needs separate dates; sufficient time and repeated difficulty change advice only', () => {
  const { data, term } = sundayFixture();
  const original = data.academic.results;
  data.academic.results = [original[0], { ...original[0], id: 'same-date', value: 68 }];
  assert.equal(comparable(data, term.id, 'school-0', '2027-01-03'), undefined);
  data.academic.results = original;
  data.sessions[0].minutes = 560;
  const without = reviewOf(data, term, inputWeek, sunday, true).courses[0];
  assert.match(without.advice, /检查训练方法/);
  assert.equal(propose(data, term, sunday, true), undefined);
  const low = sundayFixture();
  const p = propose(low.data, low.term, sunday, true);
  low.data.sessions[0].quality = '仍需继续学习';
  low.data.sessions.push(record('d1', 'school-0', 1, inputWeek, '借助提示完成'),
    record('d2', 'school-0', 1, inputWeek, '仍需继续学习'));
  const withFeedback = reviewOf(low.data, low.term, inputWeek, sunday, true).courses[0];
  assert.equal(withFeedback.hard, true);
  const change = propose(low.data, low.term, sunday, true);
  assert.deepEqual(change.after, p.after);
  assert.deepEqual(change.evidence.pair, p.evidence.pair);
  low.data.sessions.forEach(item => { item.quality = ''; });
  assert.equal(reviewOf(low.data, low.term, inputWeek, sunday, true).courses[0].hard, false);
  assert.equal(propose(low.data, low.term, sunday, true).fingerprint, change.fingerprint);
});

test('T12/T14 weekly manual override pauses an applied adjustment without mutating history', () => {
  const { data, term } = sundayFixture();
  const now = mondayAt + 2 * 3600000;
  const proposal = propose(data, term, now);
  assert.ok(proposal);
  recordDecision(data, proposal, now);
  assert.equal(data.academic.adjustments[0].appliedAt, now);
  const old = structuredClone(data);
  term.manual = { ...proposal.before };
  reconcileUpdate(old, data, now + 1000);
  const decision = data.academic.adjustments[0];
  assert.equal(decision.state, 'paused');
  assert.equal(decision.endedAt, now + 1000);
  assert.deepEqual(targetAt(data, term, now + 2000), term.manual);
  assert.deepEqual(decision.proposal, old.academic.adjustments[0].proposal);
  const oldResources = reviewOf(data, term, inputWeek, now + 2000).total;
  data.sessions[0].minutes += 25;
  data.academic.results = [];
  term.archived = true;
  data.subjects.find(item => item.id === 'school-0').name = '合成课改名';
  assert.equal(reviewOf(data, term, inputWeek, now + 2000).total, oldResources + 25);
  assert.equal(decision.proposal.evidence.pair[0].value, 61);
});
