import { localClock, monday, shiftDay, startOfDay, dayDistance, daysOf } from '../study/time.ts';
import {
  baselineAt, byId, outstanding, passesGap, recommend, relevantPlan, scheduleOf, stageAt, vectorKey,
  weeklyAllocation, weeklyRecords,
} from './allocation.ts';
import {
  inTerm, inputsOf, rules, type Adjustment, type DeskData, type Evidence, type EvidenceResult,
  type Inputs, type Proposal, type Result, type Term, type Vector,
} from './model.ts';

const epsilon = 1e-8;
const projection = ({ id, subjectId, day, at, activity, metric, value, total, scope, difficulty, condition, attempt }: Result): EvidenceResult =>
  ({ id, subjectId, day, at, activity, metric, value, total, scope, difficulty, condition, attempt });
export const normalized = (result: Pick<Result, 'value' | 'total'>) => result.total && result.value !== null ? result.value / result.total : null;
const keyOf = (result: Result) => {
  if (!result.scope || !result.difficulty || normalized(result) === null ||
      ['official', 'done'].includes(result.metric) || result.condition === 'assisted' && result.metric !== 'independent') return '';
  const condition = result.metric === 'independent' ? 'independent-count' : result.condition;
  if (condition === 'unknown') return '';
  return JSON.stringify([result.activity, result.metric, result.scope, result.difficulty, condition, result.attempt,
    result.metric === 'coverage' ? result.total : null]);
};

export function comparable(data: DeskData, termId: string, subjectId: string, day: string, asOf = Infinity) {
  const groups = new Map<string, Result[]>();
  for (const item of data.academic.results) {
    if (item.termId !== termId || item.subjectId !== subjectId || item.day > day || item.at > asOf ||
        dayDistance(item.day, day) >= rules.evidenceDays) continue;
    const key = keyOf(item);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const newer = (a: Result, b: Result) => byId(b.day, a.day) || b.at - a.at || byId(b.id, a.id);
  const paired = [...groups.values()].map(group => group.sort(newer))
    .filter(group => group.some(item => item.day !== group[0].day)).sort((a, b) => newer(a[0], b[0]))[0];
  if (!paired) return;
  const pair = [paired.find(item => item.day !== paired[0].day)!, paired[0]].map(projection) as Evidence['pair'];
  const delta = normalized(pair[1])! - normalized(pair[0])!;
  return { pair, count: paired.length, delta, trend: delta + epsilon >= rules.trend ? '提高' : delta - epsilon <= -rules.trend ? '下降' : '接近' };
}

export function configAt(data: DeskData, at: number) {
  return data.academic.versions.findLast(version => version.at <= at)?.inputs;
}
function clockOf(data: DeskData, at: number) {
  return localClock(at, data.settings.timezone);
}
function allocationAt(inputs: Inputs, termId: string, otherId: string, at: number) {
  const term = inputs.terms.find(item => item.id === termId);
  return term ? baselineAt(inputs, term, localClock(at, inputs.settings.timezone), otherId).target : {};
}
function matchingBaseline(inputs: Inputs, proposal: Proposal, otherId: string, at: number) {
  return vectorKey(allocationAt(inputs, proposal.termId, otherId, at)) === proposal.baseline;
}
const touched = (data: DeskData, termId: string, week: string) => data.academic.adjustments.some(item =>
  item.proposal.termId === termId && item.proposal.week === week && item.appliedAt !== null);

export function targetAt(data: DeskData, term: Term, at: number, historical = false): Vector {
  const inputs = historical ? configAt(data, at) : inputsOf(data);
  const zone = inputs?.settings.timezone ?? data.settings.timezone;
  const week = monday(localClock(at, zone).day);
  const adjustment = data.academic.adjustments.find(item => item.proposal.termId === term.id &&
    item.proposal.week === week && item.appliedAt !== null && item.appliedAt <= at && (item.endedAt === null || item.endedAt > at));
  const base = inputs ? allocationAt(inputs, term.id, data.academic.otherId, at) : {};
  return adjustment && vectorKey(base) === adjustment.proposal.baseline ? adjustment.proposal.after : base;
}

function historicTarget(data: DeskData, term: Term, week: string) {
  const adjustment = data.academic.adjustments.find(item => item.appliedAt !== null &&
    item.proposal.termId === term.id && item.proposal.week === week);
  const zone = adjustment?.proposal.config.settings.timezone ?? data.settings.timezone;
  const start = startOfDay(week, zone);
  const end = startOfDay(shiftDay(week, 7), zone);
  const points = [...new Set([
    ...replayPoints(data, term.id, week, start, end - 1),
    ...data.academic.versions.filter(item => item.at > start && item.at < end).map(item => item.at - 1),
    ...data.academic.adjustments.filter(item => item.proposal.termId === term.id && item.proposal.week === week)
      .flatMap(item => [item.appliedAt, item.endedAt]).filter((at): at is number => at !== null && at > start && at < end),
  ])].sort((a, b) => a - b);
  const rest = daysOf(week).filter(day => {
    const at = startOfDay(day, zone);
    const inputs = configAt(data, at);
    const prior = inputs?.terms.find(item => item.id === term.id);
    return inputs && prior && stageAt(inputs, prior, localClock(at, inputs.settings.timezone)).stage === 'vacation';
  }).length;
  if (!configAt(data, start) || rest >= rules.restDays) return;
  const baseline = targetAt(data, term, start, true);
  if (Object.keys(baseline).length && points.every(at => vectorKey(targetAt(data, term, at, true)) === vectorKey(baseline))) return baseline;
}

function investment(data: DeskData, term: Term, week: string, day: string) {
  const target = historicTarget(data, term, week) ?? {};
  const summary = weeklyAllocation(data, term, week, { day, minute: 1439 }, target);
  return (id: string) => {
    const minutes = summary.minutes[id] ?? 0;
    const planned = summary.budget !== null && target[id] > 0 ? target[id] * summary.budget : null;
    const gaps = summary.differences[id] ?? null;
    let investment: Evidence['investment'] = 'unknown';
    if (planned !== null && summary.budget! > 0) {
      investment = planned - minutes > Math.max(rules.minGap, planned * rules.budgetTolerance) ? 'low' : 'enough';
    } else if (gaps && summary.total >= rules.sample && summary.qualified >= rules.sample) {
      investment = passesGap(gaps[0], summary.total) && passesGap(gaps[1], summary.qualified) ? 'low' : 'enough';
    }
    return { minutes, planned, investment, gaps };
  };
}

export function reviewOf(data: DeskData, term: Term, week: string, now: number, closeSunday = false) {
  const clock = clockOf(data, now);
  const activeWeek = monday(clock.day);
  const through = week < activeWeek ? shiftDay(week, 6) : clock.day;
  const complete = week < activeWeek || (closeSunday && clock.day === shiftDay(week, 6));
  const history = complete ? historicTarget(data, term, week) : targetAt(data, term, now);
  const summary = weeklyAllocation(data, term, week, { day: through, minute: 1439 }, history ?? {});
  const evaluate = investment(data, term, week, through);
  const results = data.academic.results.filter(item => item.termId === term.id && item.day >= week && item.day <= through);
  const cutoff = startOfDay(shiftDay(through, 1), data.settings.timezone) - 1;
  const historic = complete ? configAt(data, Math.min(now, cutoff))?.terms.find(item => item.id === term.id) : undefined;
  const courses = (historic?.courses ?? term.courses).map(course => {
    const comparison = comparable(data, term.id, course.subjectId, through);
    const effort = evaluate(course.subjectId);
    const record = summary.records.filter(item => item.subjectId === course.subjectId && inTerm(item.day, term));
    const feedback = record.map(item => item.quality).filter(Boolean);
    const hard = feedback.length >= rules.hardFeedback && feedback.every(item => item !== '能够独立应用');
    const goal = complete && !historic ? null : comparison?.pair[0].metric === 'coverage' ? course.coverageGoal : course.goal;
    const values = comparison?.pair.map(normalized);
    const bothLow = !!(goal != null && values?.every(value => value! < goal));
    const bothHigh = !!(goal != null && values?.every(value => value! >= goal));
    const advice = !comparison || goal == null ? '证据不足，可做一次可比较的小测'
      : comparison.pair[0].metric === 'coverage' ? (bothHigh ? '覆盖达标，可考虑切换到维持' : '继续题库覆盖和主动回忆')
      : bothLow && comparison.trend !== '提高' ? (complete && effort.investment === 'enough'
        ? '建议检查训练方法，先做针对性专项' : complete && effort.investment === 'low'
          ? '可预览增加下一执行周的份额' : '投入证据不足，建议先诊断')
      : bothHigh ? '可预览维持或减少下一执行周的份额' : '维持安排，继续跟踪';
    return { course, comparison, goal, bothLow, bothHigh, effort, feedback, hard, advice };
  });
  return {
    ...summary, courses, complete, history, through, results,
    trend: [3, 2, 1, 0].map(offset => {
      const key = shiftDay(week, -7 * offset);
      const records = weeklyRecords(data, key, through);
      return { week: key, minutes: records.length ? records.reduce((sum, item) => sum + item.minutes, 0) : null };
    }),
  };
}

export function executionWeek(data: DeskData, termId: string, now: number) {
  const clock = clockOf(data, now);
  const week = monday(clock.day);
  const schoolTimer = data.timer && data.subjects.some(subject => subject.id === data.timer!.subjectId && subject.track === 'school');
  const immediate = clock.day === week && !schoolTimer && !weeklyRecords(data, week, clock.day).length && !touched(data, termId, week);
  const next = immediate ? week : shiftDay(week, 7);
  return { week: next, effectiveAt: immediate ? now : startOfDay(next, data.settings.timezone) };
}

function configurationKey(inputs: Inputs, termId: string) {
  const term = inputs.terms.find(item => item.id === termId);
  if (!term) return '';
  const subjects = new Set(term.courses.map(course => course.subjectId));
  return JSON.stringify({
    from: term.from, through: term.through, archived: term.archived, reserve: term.reserve,
    override: term.override, manual: term.manual ? vectorKey(term.manual) : null,
    routes: term.routes.map(({ from, through, stage }) => [from, through, stage]),
    courses: term.courses.map(({ strategy, focus, focus2, ...course }) => course).sort((a, b) => byId(a.subjectId, b.subjectId)),
    schedule: scheduleOf(inputs, term).map(({ title, ...item }) => item),
    archivedSubjects: inputs.archived.filter(id => subjects.has(id)),
    zone: inputs.settings.timezone, untimed: inputs.settings.untimedExam, vacation: inputs.settings.vacation,
    phase: inputs.settings.override,
  });
}

function fingerprint(data: DeskData, termId: string, week: string, asOf: number) {
  const today = clockOf(data, asOf).day;
  const config = inputsOf(data);
  return JSON.stringify({
    config: configurationKey(config, termId), budget: relevantPlan(data, week)?.budget ?? null,
    records: weeklyRecords(data, week, today).map(({ id, day, subjectId, minutes }) => [id, day, subjectId, minutes])
      .sort(([a], [b]) => byId(String(a), String(b))),
    comparisons: (config.terms.find(term => term.id === termId)?.courses ?? []).map(course =>
      [course.subjectId, comparable(data, termId, course.subjectId, today)]).sort(([a], [b]) => byId(String(a), String(b))),
    history: data.academic.versions.filter(version =>
      version.at > startOfDay(week, data.settings.timezone) && version.at <= asOf).map(version => configurationKey(version.inputs, termId))
      .filter((key, index, history) => !index || key !== history[index - 1]),
    initial: configAt(data, startOfDay(week, data.settings.timezone))
      ? configurationKey(configAt(data, startOfDay(week, data.settings.timezone))!, termId) : '',
  });
}

export function propose(data: DeskData, term: Term, now: number, closeSunday = false): Proposal | undefined {
  const time = clockOf(data, now);
  const currentWeek = monday(time.day);
  const inputWeek = closeSunday && time.day === shiftDay(currentWeek, 6) ? currentWeek : shiftDay(currentWeek, -7);
  const { week, effectiveAt } = executionWeek(data, term.id, now);
  const inputs = inputsOf(data);
  const before = allocationAt(inputs, term.id, data.academic.otherId, effectiveAt);
  const report = reviewOf(data, term, inputWeek, now, closeSunday);
  if (!report.history || stageAt(inputs, term, localClock(effectiveAt, data.settings.timezone)).stage === 'vacation') return;
  const last = investment(data, term, inputWeek, report.through);
  const schedule = scheduleOf(inputs, term);
  const entries = term.courses.filter(course => before[course.subjectId] > 0).map(course => {
    const pair = comparable(data, term.id, course.subjectId, time.day, now);
    const effort = last(course.subjectId);
    const goal = course.goal;
    const quant = pair && pair.pair[0].metric !== 'coverage' && goal !== null;
    const bothLow = !!(quant && pair.pair.every(result => normalized(result)! < goal));
    const bothHigh = !!(quant && pair.pair.every(result => normalized(result)! >= goal));
    const urgent = schedule.some(item => item.subjectId === course.subjectId && outstanding(item) &&
      dayDistance(time.day, item.day) <= rules.examDays && (item.kind !== 'exam' || item.day >= time.day));
    const deficit = (effort.planned ?? effort.minutes + (effort.gaps?.[1] ?? 0)) - effort.minutes;
    return { id: course.subjectId, pair, goal, effort, bothLow, bothHigh, urgent, deficit, course };
  });
  const increase = entries.filter(entry => entry.bothLow && entry.pair?.trend !== '提高' && entry.effort.investment === 'low')
    .sort((a, b) => b.deficit - a.deficit || byId(a.id, b.id));
  const decrease = entries.filter(entry => entry.bothHigh && !entry.urgent)
    .sort((a, b) => a.deficit - b.deficit || byId(a.id, b.id));
  for (const candidate of [...increase, ...decrease]) {
    const expanding = increase.includes(candidate);
    const others = entries.filter(entry => entry !== candidate && (expanding
      ? !entry.urgent && (entry.bothHigh || entry.pair?.trend === '提高') && entry.effort.investment === 'enough'
      : entry.course.status === 'strengthen' || entry.effort.investment === 'low'));
    const counterpart = others.sort((a, b) => (expanding ? a.deficit - b.deficit : b.deficit - a.deficit) || byId(a.id, b.id))[0];
    if (!counterpart) continue;
    const [recipient, donor] = expanding ? [candidate.id, counterpart.id] : [counterpart.id, candidate.id];
    const change = Math.min(rules.change, before[donor], 1 - term.reserve - before[recipient]);
    if (change <= epsilon) continue;
    const after = { ...before, [donor]: before[donor] - change, [recipient]: before[recipient] + change };
    const { pair, count } = candidate.pair!;
    const key = fingerprint(data, term.id, inputWeek, now);
    if (data.academic.adjustments.some(item => item.state === 'rejected' && item.proposal.week === week &&
      item.proposal.termId === term.id && item.proposal.fingerprint === key)) return;
    return {
      termId: term.id, week, effectiveAt, asOf: now, inputWeek, rule: rules.version,
      baseline: vectorKey(before), fingerprint: key, before, after,
      evidence: { subjectId: candidate.id, pair, count, goal: candidate.goal!, ...candidate.effort,
        direction: expanding ? 'increase' : 'decrease' },
      config: structuredClone(inputs), inputConfig: structuredClone(data.academic.versions.filter((version, index, all) =>
        version.at <= now && (all[index + 1]?.at ?? Infinity) > startOfDay(inputWeek, data.settings.timezone))),
      budget: report.budget,
    };
  }
}

export function recordDecision(data: DeskData, preview: Proposal, now: number, reject = false) {
  const { adjustments } = data.academic;
  if (adjustments.some(item => item.proposal.termId === preview.termId && item.proposal.week === preview.week &&
    (item.appliedAt !== null || item.state === 'pending' || item.state === 'rejected') &&
    item.proposal.fingerprint === preview.fingerprint)) return;
  const term = data.academic.terms.find(item => item.id === preview.termId && !item.archived);
  const latest = term && propose(data, term, now, preview.inputWeek === monday(clockOf(data, now).day));
  if (!latest || latest.week !== preview.week || latest.rule !== preview.rule || latest.fingerprint !== preview.fingerprint ||
      latest.baseline !== preview.baseline || vectorKey(latest.after) !== vectorKey(preview.after) ||
      adjustments.some(item => item.proposal.termId === preview.termId && item.proposal.week === preview.week &&
        (item.appliedAt !== null || item.state === 'pending'))) {
    throw new Error('预览已过期或该周已有确认方案，请重新查看周报。');
  }
  const immediate = latest.effectiveAt <= now;
  adjustments.push({
    proposal: latest, confirmedAt: now, state: reject ? 'rejected' : immediate ? 'applied' : 'pending',
    appliedAt: !reject && immediate ? now : null, endedAt: null, reason: '',
  });
}

function transitionPoints(inputs: Inputs, termId: string, week: string) {
  const term = inputs.terms.find(item => item.id === termId);
  const zone = inputs.settings.timezone;
  const days = daysOf(week);
  const cutoffs = term ? scheduleOf(inputs, term).filter(item => days.includes(item.day) && item.cutoff < 1440)
    .map(item => startOfDay(item.day, zone) + item.cutoff * 60000) : [];
  return [...new Set([...days.map(day => startOfDay(day, zone)), ...cutoffs])].sort((a, b) => a - b);
}

// A calendar transition is only relevant while the configuration that defines it was in force.
function replayPoints(data: DeskData, termId: string, week: string, from: number, through: number, fallback?: Inputs) {
  const changes = data.academic.versions.filter(version => version.at > from && version.at <= through);
  const boundaries = [...new Set([from, ...changes.map(version => version.at), through + 1])];
  const points = new Set([from, through]);
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    points.add(start);
    const inputs = configAt(data, start) ?? fallback;
    if (inputs) {
      for (const point of transitionPoints(inputs, termId, week)) {
        if (point >= start && point < end) points.add(point);
      }
    }
  }
  return [...points].sort((a, b) => a - b);
}

// Read and update both call this before modifying the shared transaction's inputs.
export function settle(data: DeskData, now: number) {
  for (const item of data.academic.adjustments) {
    const { proposal } = item;
    if (item.state === 'pending' && proposal.effectiveAt <= now) {
      const effectiveInputs = configAt(data, proposal.effectiveAt) ?? proposal.config;
      if (proposal.rule !== rules.version ||
          !matchingBaseline(effectiveInputs, proposal, data.academic.otherId, proposal.effectiveAt) ||
          fingerprint(data, proposal.termId, proposal.inputWeek, proposal.asOf) !== proposal.fingerprint) {
        end(item, 'invalid', proposal.effectiveAt, '生效前证据或目标分配已变化，请重新预览。');
        continue;
      }
      item.state = 'applied';
      item.appliedAt = proposal.effectiveAt;
    }
    if (item.state !== 'applied') continue;
    const endOfWeek = startOfDay(shiftDay(proposal.week, 7), proposal.config.settings.timezone);
    const through = Math.min(now, endOfWeek - 1);
    if (through <= item.appliedAt!) continue;
    const points = replayPoints(data, proposal.termId, proposal.week, item.appliedAt!, through, proposal.config);
    for (const point of points) {
      const inputs = configAt(data, point) ?? proposal.config;
      if (point === item.appliedAt || matchingBaseline(inputs, proposal, data.academic.otherId, point)) continue;
      end(item, 'paused', point, '有效课程或分配基线已变化，恢复当前配置。');
      break;
    }
  }
}

function end(item: Adjustment, state: 'invalid' | 'paused', at: number, reason: string) {
  item.state = state;
  item.endedAt = at;
  item.reason = reason;
}
export function reconcileUpdate(before: DeskData, after: DeskData, now: number) {
  const oldInputs = inputsOf(before);
  const newInputs = inputsOf(after);
  if (JSON.stringify(oldInputs) !== JSON.stringify(newInputs)) {
    const at = Math.max(now, after.academic.versions.at(-1)?.at ?? 0);
    after.academic.versions.push({ at, inputs: structuredClone(newInputs) });
  }
  for (const item of after.academic.adjustments) {
    const { proposal } = item;
    if (item.state === 'pending' && fingerprint(after, proposal.termId, proposal.inputWeek, proposal.asOf) !== proposal.fingerprint) {
      end(item, 'invalid', now, '确认所依据的配置、课次或成果已变化，请重新确认。');
    }
    if (item.state === 'applied' && item.appliedAt! <= now && now < startOfDay(shiftDay(proposal.week, 7), proposal.config.settings.timezone)) {
      const oldManual = oldInputs.terms.find(term => term.id === proposal.termId)?.manual;
      const manual = newInputs.terms.find(term => term.id === proposal.termId)?.manual;
      if (JSON.stringify(oldManual) !== JSON.stringify(manual) || !matchingBaseline(newInputs, proposal, after.academic.otherId, now)) {
        end(item, 'paused', now, '手动分配或有效课程已变化，恢复当前配置。');
      }
    }
  }
}

export interface AnalysisInput {
  version: number; timezone: string; week: string; totalMinutes: number;
  courses: { ref: string; minutes: number; evidenceCount: number }[];
}
export interface AnalysisSuggestion {
  version: number; courseRef: string; reasonCode: string; evidenceRefs: string[]; action: string;
  requiresConfirmation: boolean; limits: string[];
}
export function analysisInput(data: DeskData, term: Term, week: string, now: number): Readonly<AnalysisInput> {
  const report = reviewOf(data, term, week, now);
  return { version: rules.version, timezone: data.settings.timezone, week, totalMinutes: report.total,
    courses: report.courses.map((entry, index) => ({
      ref: 'course-' + (index + 1), minutes: report.minutes[entry.course.subjectId] ?? 0,
      evidenceCount: entry.comparison?.count ?? 0,
    })) };
}

export function analysisSuggestion(data: DeskData, term: Term, now: number): Readonly<AnalysisSuggestion> | undefined {
  const clock = clockOf(data, now);
  const suggestion = recommend(data, term, clock, targetAt(data, term, now));
  if (!suggestion) return;
  const courseIndex = term.courses.findIndex(course => course.subjectId === suggestion.subjectId);
  const sourceIndex = scheduleOf(inputsOf(data), term).findIndex(item => item.id === suggestion.evidenceId);
  return {
    version: rules.version, courseRef: courseIndex < 0 ? 'unconfigured' : 'course-' + (courseIndex + 1),
    reasonCode: suggestion.code, evidenceRefs: sourceIndex < 0 ? [] : ['deadline-' + (sourceIndex + 1)],
    action: suggestion.code === 'manual' ? 'manual-focus' : suggestion.code,
    requiresConfirmation: false, limits: ['rule-based', 'local-records-only'],
  };
}
