import { emptyData } from '../../src/features/study/model.ts';
import { calculateBudget } from '../../src/features/study/planning.ts';
import { blankCourse, inputsOf, migrateStudy } from '../../src/features/academic/model.ts';

export const instant = date => Date.parse(date + '+08:00');
export const sunday = instant('2027-01-03T20:00:00');
export const mondayAt = instant('2027-01-04T00:00:00');
export const tuesdayAt = instant('2027-01-05T00:00:00');
export const wednesday = instant('2027-01-06T10:00:00');
export const inputWeek = '2026-12-28';
export const record = (id, subjectId, minutes, day = inputWeek, quality = '') =>
  ({ id, subjectId, minutes, day, quality, note: 'synthetic record' });
export const sharedExam = (subjectId, day, patch = {}) => ({
  id: 'synthetic-exam', subjectId, day, start: '', end: '', name: '合成考试',
  importance: 'normal', mastery: 'new', status: 'scheduled', note: '', ...patch,
});
export const result = (id, subjectId, day, value, patch = {}) => ({
  id, termId: 'term-test', subjectId, day, at: instant(day + 'T15:00:00'),
  activity: '样题练习', metric: 'score', value, total: 100, prompted: null, scope: '合成范围',
  difficulty: 'standard', condition: 'independent', attempt: 'first', tags: [], note: '', sessionId: '', ...patch,
});
export const plan = (data, school = 1000) => {
  const minutes = [school, 0, 0, 0, 0, 0, 0];
  const beforeExam = Array(7).fill(null);
  const budget = calculateBudget(inputWeek, minutes, beforeExam, data.exams, data.settings);
  return { week: inputWeek, minutes, beforeExam, budget, manual: [budget.allocatable, 0, 0],
    previousTargets: [0, 0, 0], revision: 3, updatedAt: instant(inputWeek + 'T00:00:00'), focus: 'synthetic plan' };
};
export function legacy({ pause = false, duplicate = false } = {}) {
  const data = emptyData();
  data.subjects[0].archived = true;
  data.subjects.find(item => item.id === 'self-3').name = '高等数学';
  if (duplicate) data.subjects.push({ id: 'old-c-lab', name: '程序设计', track: 'school', archived: false });
  data.sessions.push(record('old-math', 'school-0', 120), record('old-self', 'self-3', 30), record('old-project', 'project-0', 25));
  data.exams.push(sharedExam('school-2', inputWeek, { status: 'completed', closedAt: instant(inputWeek + 'T14:00:00') }));
  data.plans.push(plan(data));
  data.reviews.push({ week: inputWeek, balance: 'synthetic balance', knowledge: '', results: '', issues: '', nextFocus: '' });
  data.timer = { id: 'old-timer', subjectId: 'school-2', day: inputWeek, startedAt: mondayAt - 60000,
    elapsedMs: 60000, runningSince: pause ? null : mondayAt - 60000 };
  return data;
}
export function academic() {
  const data = migrateStudy(emptyData());
  const courses = [
    ['school-0', 'ability', 45], ['school-2', 'ability', 23], ['school-1', 'ability', 11],
    ['academic-history', 'bank', 10], ['academic-health', 'task', 5], ['academic-intro', 'bank', 3],
  ].map(([subjectId, mode, target]) => ({
    ...blankCourse(subjectId), mode, credits: 3, finalShare: 1, cost: 6.5 * target / 97 / 3,
    status: 'normal', goal: .85,
  }));
  // All values are synthetic; keep the demonstration weight ratio within the cost interval.
  for (const course of courses) {
    const raw = course.credits * course.cost;
    course.credits = raw;
    course.cost = 1;
  }
  const term = { id: 'term-test', name: '合成学期', from: '2026-10-01', through: '2027-02-01',
    archived: false, examWeek: '', reserve: .03, override: '', manual: null, courses, routes: [] };
  data.academic.terms.push(term);
  data.academic.currentTerm = term.id;
  return { data, term };
}
export function sundayFixture({ activates = true } = {}) {
  const { data, term } = academic();
  if (activates) data.exams.push(sharedExam('academic-history', '2027-01-19'));
  data.plans.push(plan(data));
  data.sessions.push(record('math-time', 'school-0', 60), record('c-time', 'school-2', 340), record('en-time', 'school-1', 250));
  data.academic.results.push(result('math-a', 'school-0', '2026-12-30', 61), result('math-b', 'school-0', '2027-01-01', 65),
    result('c-a', 'school-2', '2026-12-30', 90), result('c-b', 'school-2', '2027-01-01', 91));
  data.academic.versions.push({ at: instant('2026-12-01T00:00:00'), inputs: structuredClone(inputsOf(data)) });
  return { data, term };
}

export function largeBackupData() {
  const { data } = sundayFixture();
  const note = '测'.repeat(2000);
  data.sessions = Array.from({ length: 5600 }, (_, index) =>
    ({ ...record('sample-' + index, 'school-0', 15, '2027-01-03'), note }));
  return data;
}
