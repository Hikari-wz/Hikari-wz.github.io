import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, emptyData, defaultRatios } from '../src/features/study/model.ts';
import { calculateBudget, phaseAt, timerMs } from '../src/features/study/planning.ts';
import { migrateStudy } from '../src/features/academic/model.ts';
import { exportBackup, importBackup } from '../src/features/study/storage.ts';
import { localClock, monday, shiftDay } from '../src/features/study/time.ts';
import { guidance, remainingAvailable, summarize } from '../src/features/study/statistics.ts';

const week = '2026-12-28';
const noon = { day: week, minute: 720 };
const exam = (day, overrides = {}) => ({
  id: 'exam-1', name: '高等数学期末', subjectId: 'school-0', day, start: '', end: '',
  mastery: 'new', importance: 'important', status: 'scheduled', note: '', ...overrides,
});
const before = Array(7).fill(null);
const session = (id, day, subjectId, minutes, quality = '') => ({ id, day, subjectId, minutes, quality, note: '' });
const planFor = (data, minutes, date = week) => ({
  week: date, minutes, beforeExam: before, budget: calculateBudget(date, minutes, before, data.exams, data.settings),
  manual: null, previousTargets: null, revision: 1, updatedAt: Date.now(), focus: '',
});

test('phase boundaries, vacation, lower importance, manual override and ended exams', () => {
  const settings = defaultSettings();
  for (const [days, phase] of [[0, 'sprint'], [3, 'sprint'], [4, 'review'], [14, 'review'], [15, 'prepare'], [28, 'prepare'], [29, 'normal']]) {
    assert.equal(phaseAt([exam(shiftDay(week, days))], noon, settings).phase, phase);
  }
  assert.equal(phaseAt([], noon, settings).phase, 'normal');
  assert.equal(phaseAt([exam(week, { importance: 'normal' }), exam(week, { importance: 'low' })], noon, settings).phase, 'normal');
  const finished = [exam(week, { status: 'cancelled' }), exam(week, { status: 'completed' }), exam(week, { end: '12:00' })];
  assert.equal(phaseAt(finished, noon, settings).phase, 'normal');
  settings.vacation = true;
  assert.equal(phaseAt(finished, noon, settings).phase, 'vacation');
  assert.equal(phaseAt([exam(shiftDay(week, 28))], noon, settings).phase, 'prepare');
  settings.override = 'review';
  assert.deepEqual(phaseAt([], noon, settings), { exam: undefined, distance: Infinity, automatic: 'vacation', phase: 'review' });
});

test('five default ratios, integer apportionment, 28-hour example, and custom ratios', () => {
  const settings = defaultSettings();
  for (const phase of Object.keys(defaultRatios)) {
    settings.override = phase;
    const expected = defaultRatios[phase].map(value => value * 9);
    assert.deepEqual(calculateBudget(week, [1000, 0, 0, 0, 0, 0, 0], before, [], settings).targets, expected);
  }
  settings.override = 'auto';
  const varied = [240, 60, 240, 180, 240, 360, 360];
  const budget = calculateBudget(week, varied, before, [], settings);
  assert.deepEqual([budget.available, budget.reserve, budget.allocatable], [1680, 168, 1512]);
  assert.deepEqual(budget.targets, [529, 756, 227]);
  settings.buffer = 25;
  settings.ratios.normal = [20, 65, 15];
  assert.deepEqual(calculateBudget(week, varied, before, [], settings).targets, [252, 819, 189]);
  assert.deepEqual(calculateBudget(week, Array(7).fill(0), before, [], settings).targets, [0, 0, 0]);
  settings.buffer = 100;
  assert.deepEqual(calculateBudget(week, varied, before, [], settings).targets, [0, 0, 0]);
});

test('one week crosses phases and uses the last important exam end for that day', () => {
  const settings = defaultSettings();
  settings.buffer = 0;
  const day = '2027-01-01';
  const exams = [
    exam(day, { end: '10:00' }), exam(day, { id: 'exam-2', start: '12:00', end: '14:00' }),
    exam(day, { id: 'exam-3', end: '19:00', importance: 'normal' }),
    exam('2027-01-10', { id: 'exam-4' }),
  ];
  assert.equal(phaseAt(exams, { day, minute: 13 * 60 }, settings).phase, 'sprint');
  assert.equal(phaseAt(exams, { day, minute: 14 * 60 }, settings).phase, 'review');
  const budget = calculateBudget(week, [60, 0, 0, 0, 200, 0, 60], [null, null, null, null, 100, null, null], exams, settings);
  assert.deepEqual(budget.days[0].parts, [{ phase: 'review', minutes: 60 }]);
  assert.deepEqual(budget.days[1].parts, [{ phase: 'sprint', minutes: 0 }]);
  assert.deepEqual(budget.days[4].parts, [{ phase: 'sprint', minutes: 100 }, { phase: 'review', minutes: 100 }]);
  assert.deepEqual(budget.targets, [233, 65, 22]);
  const onlyExam = exam(day, { start: '15:00' });
  assert.equal(phaseAt([onlyExam], { day, minute: 1439 }, settings).phase, 'sprint');
  settings.untimedExam = 'midday';
  assert.equal(phaseAt([onlyExam], { day, minute: 900 }, settings).phase, 'sprint');
  assert.equal(phaseAt([onlyExam], { day, minute: 901 }, settings).phase, 'normal');
  const completed = { ...onlyExam, status: 'completed', closedAt: Date.parse('2027-01-01T07:10:00Z') };
  assert.equal(phaseAt([completed], { day, minute: 920 }, settings).phase, 'normal');
  assert.equal(calculateBudget(week, [0, 0, 0, 0, 60, 0, 0], before, [completed], settings).days[4].parts.length, 2);
});

test('civil time uses selected timezone at a year boundary and handles DST dates', () => {
  const instant = Date.parse('2027-01-03T16:00:00Z');
  assert.deepEqual(localClock(instant, 'Asia/Shanghai'), { day: '2027-01-04', minute: 0 });
  assert.deepEqual(localClock(instant, 'America/New_York'), { day: '2027-01-03', minute: 660 });
  assert.equal(monday('2027-01-01'), '2026-12-28');
  assert.equal(shiftDay('2028-02-28', 2), '2028-03-01');
  assert.equal(monday('2027-03-14'), '2027-03-08');
});

test('versioned backups keep historical snapshots and archived references', () => {
  const data = emptyData();
  data.plans.push(planFor(data, Array(7).fill(240)));
  data.subjects[0].archived = true;
  data.sessions.push(session('s1', week, 'school-0', 99, '能够独立应用'));
  data.settings.ratios.normal = [100, 0, 0];
  const encoded = exportBackup(data);
  const restored = importBackup(encoded);
  assert.deepEqual(restored, migrateStudy(data));
  assert.deepEqual(importBackup(exportBackup(restored)), restored);
  assert.deepEqual(restored.plans[0].budget.targets, [529, 756, 227]);
  assert.equal(summarize(restored, restored.sessions).subjects[0].minutes, 99);
  assert.throws(() => importBackup('{'), /JSON/);
  assert.throws(() => importBackup(encoded.replace('"version": 1', '"version": 99')), /版本/);
  assert.throws(() => importBackup(encoded.replace('"minutes": 99', '"minutes": 0')), /无效/);
  assert.throws(() => importBackup(encoded.replace('"subjectId": "school-0"', '"subjectId": "missing"')), /无效/);
  assert.throws(() => importBackup(encoded.replace('"reserve": 168', '"reserve": 167')), /无效/);
});

test('timer duration is derived from persisted timestamps, apart from paused time', () => {
  const start = Date.parse('2027-01-01T02:00:00Z');
  const timer = { id: 's1', day: '2027-01-01', subjectId: 'self-0', startedAt: start, runningSince: start, elapsedMs: 0 };
  assert.equal(timerMs(timer, start + 10800000), 10800000);
  const paused = { ...timer, runningSince: null, elapsedMs: 2700000 };
  assert.equal(timerMs(paused, start + 10800000), 2700000);
  assert.equal(timerMs({ ...paused, runningSince: start + 10800000 }, start + 11700000), 3600000);
  assert.equal(timerMs(timer, start - 1000), 0);
});

test('warnings use completed planned days, sample size and a genuine remaining budget', () => {
  const data = emptyData();
  const plan = planFor(data, [120, 0, 120, 0, 120, 240, 240]);
  data.plans.push(plan);
  assert.deepEqual(guidance(data, noon, 'normal', plan).messages, []);
  data.sessions.push(session('s1', week, 'school-0', 100, '借助提示完成'));
  assert.deepEqual(guidance(data, { day: shiftDay(week, 2), minute: 900 }, 'normal', plan).messages, []);
  data.sessions.push(session('s2', shiftDay(week, 2), 'school-0', 100, '借助提示完成'));
  data.sessions.push(session('s3', shiftDay(week, 4), 'school-0', 100, '借助提示完成'));
  data.sessions.push(session('s4', shiftDay(week, 5), 'project-0', 145));
  const saturday = { day: shiftDay(week, 5), minute: 720 };
  assert.equal(remainingAvailable(plan, data.sessions, saturday), 335);
  const messages = guidance(data, saturday, 'normal', plan).messages;
  for (const text of ['三个', '提示', '5 个百分点', '一半', '可用时间低于', '明显缺口']) {
    assert.ok(messages.some(message => message.includes(text)), text);
  }
  data.sessions.push(session('s5', shiftDay(week, 5), 'self-0', 400));
  assert.match(guidance(data, saturday, 'normal', plan).next, /自由安排/);
});
