import { examCutoff, phaseAt, untimedCutoff } from '../study/planning.ts';
import { targetsOf } from '../study/statistics.ts';
import { clockMinute, dayDistance, localClock, monday, shiftDay } from '../study/time.ts';
import {
  inTerm, inputsOf, outsideId, reserveId, rules,
  type Course, type DeskData, type Inputs, type Stage, type Term, type Vector,
} from './model.ts';

type Clock = ReturnType<typeof localClock>;
export const totalOf = (values: number[]) => values.reduce((sum, number) => sum + number, 0);
export const byId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const courseId = (course: Course) => course.subjectId;
export const stageNames: Record<Stage, string> = {
  normal: '常规学习', prepare: '能力补强', review: '期末复习', sprint: '考前验收', vacation: '休息',
};
export function stageAt(inputs: Inputs, term: Term, clock: Clock) {
  const routes = term.routes.filter(item => clock.day >= item.from && clock.day <= item.through);
  const route = routes.find(item => item.stage === 'vacation') ?? routes[0];
  const stage: Stage = inputs.settings.vacation || term.override === 'vacation' || route?.stage === 'vacation'
    ? 'vacation' : term.override || route?.stage || phaseAt(inputs.exams, clock, inputs.settings).phase;
  return { stage, route };
}

export function scheduleOf(inputs: Inputs, term: Term) {
  const assessments = inputs.assessments.filter(item => item.termId === term.id);
  const details = new Map(assessments.filter(item => item.examId).map(item => [item.examId, item]));
  return [
    ...assessments.filter(item => !item.examId).map(item => ({
      ...item,
      cutoff: item.time ? clockMinute(item.time) : untimedCutoff(inputs.settings),
      formal: false,
    })),
    ...inputs.exams.filter(exam => inTerm(exam.day, term) &&
      inputs.school.includes(exam.subjectId)).map(exam => {
      const detail = details.get(exam.id);
      return {
        id: exam.id, termId: term.id, title: exam.name, kind: 'exam' as const, examId: exam.id,
        subjectId: exam.subjectId, certainty: 'confirmed' as const, status: exam.status, day: exam.day,
        time: exam.end, prepare: detail?.prepare ?? '', required: detail?.required ?? false,
        cutoff: examCutoff(exam, inputs.settings), formal: true,
      };
    }),
  ].sort((a, b) => byId(a.day, b.day) || a.cutoff - b.cutoff || byId(a.id, b.id));
}
export type Scheduled = ReturnType<typeof scheduleOf>[number];
export const outstanding = (item: Scheduled) => item.status === 'scheduled' && item.certainty === 'confirmed' && !!item.day;
export const stillAhead = (item: Scheduled, clock: Clock) =>
  item.day > clock.day || (item.day === clock.day && clock.minute < item.cutoff);
const isExam = (item: Scheduled) => item.kind === 'exam';
export function availableCourse(inputs: Inputs, term: Term, course: Course) {
  return !term.archived && !course.disabled && course.status !== 'completed' &&
    !inputs.archived.includes(course.subjectId);
}

export function courseStatus(inputs: Inputs, term: Term, course: Course, clock: Clock, schedule = scheduleOf(inputs, term)) {
  const items = schedule.filter(item => item.subjectId === course.subjectId);
  const required = items.filter(item => item.required && item.status !== 'cancelled');
  const done = !!course.checklist?.length && JSON.stringify(required.map(item => item.id).sort(byId)) === JSON.stringify(course.checklist) &&
    required.every(item => item.certainty === 'confirmed' && item.status === 'completed');
  const direct = items.filter(item => outstanding(item) && stillAhead(item, clock));
  const exam = direct.find(isExam);
  const due = exam ? dayDistance(clock.day, exam.day) : Infinity;
  const stale = items.some(item => isExam(item) && outstanding(item) && !stillAhead(item, clock)) && !direct.length;
  const eligible = inTerm(clock.day, term) && availableCourse(inputs, term, course) && !done;
  const explicit = !!(course.from || course.through) && (!course.from || clock.day >= course.from) && (!course.through || clock.day <= course.through);
  const taskWindow = direct.some(item => clock.day >= (item.prepare || shiftDay(item.day, -rules.taskDays)));
  const activated = course.activation === 'on' || (course.activation === 'auto' && !stale &&
    (course.mode === 'ability' || explicit || (course.mode === 'bank' ? due <= rules.bankDays : taskWindow)));
  return { items, exam, due, done: done || course.status === 'completed', stale, eligible, active: eligible && activated && course.status !== 'achieved' };
}

const ordered = (values: Vector) => Object.fromEntries(Object.entries(values).sort(([a], [b]) => byId(a, b)));
export const vectorKey = (values: Vector) => JSON.stringify(ordered(values));
export function baselineAt(inputs: Inputs, term: Term, clock: Clock, otherId: string) {
  const schedule = scheduleOf(inputs, term);
  const courses = term.courses.map(course => ({ course, ...courseStatus(inputs, term, course, clock, schedule) }));
  const weights: Vector = Object.create(null);
  for (const { course, active } of courses) {
    if (active && course.subjectId !== otherId && course.credits && course.finalShare && course.cost) {
      weights[course.subjectId] = course.credits * course.finalShare * course.cost;
    }
  }
  const weight = totalOf(Object.values(weights));
  const natural: Vector = weight > 0 ? {
    ...Object.fromEntries(Object.entries(weights).map(([id, raw]) => [id, raw / weight * (1 - term.reserve)])),
    [reserveId]: term.reserve,
  } : {};
  const matches = term.manual && Object.keys(natural).length > 0 &&
    JSON.stringify(Object.keys(term.manual).sort(byId)) === JSON.stringify(Object.keys(natural).sort(byId)) &&
    term.manual[reserveId] === term.reserve;
  return { courses, schedule, weights: natural, target: matches ? term.manual! : natural };
}

export function apportion(vector: Vector, total: number): Vector {
  const parts = Object.entries(vector).map(([id, ratio]) => {
    const exact = ratio * total;
    return { id, integer: Math.floor(exact), rest: exact % 1 };
  });
  let left = total - totalOf(parts.map(item => item.integer));
  parts.sort((a, b) => b.rest - a.rest || byId(a.id, b.id));
  return Object.fromEntries(parts.map(item => [item.id, item.integer + (left-- > 0 ? 1 : 0)]));
}

export function weeklyRecords(data: DeskData, week: string, through: string) {
  const subjects = new Set(data.subjects.filter(item => item.track === 'school').map(item => item.id));
  const end = shiftDay(week, 7);
  return data.sessions.filter(item => item.day >= week && item.day < end && item.day <= through && subjects.has(item.subjectId));
}

export function weeklyAllocation(data: DeskData, term: Term, week: string, clock: Clock, target: Vector) {
  const records = weeklyRecords(data, week, clock.day);
  const minutes: Vector = Object.create(null);
  const days = new Map<string, Set<string>>();
  for (const record of records) {
    const id = inTerm(record.day, term) ? record.subjectId : outsideId;
    minutes[id] = (minutes[id] ?? 0) + record.minutes;
    if (!days.has(id)) days.set(id, new Set());
    days.get(id)!.add(record.day);
  }
  const total = totalOf(Object.values(minutes));
  const budgetPlan = data.plans.find(plan => plan.week === week);
  const budget = budgetPlan ? targetsOf(budgetPlan)[0] : null;
  const qualified = totalOf(Object.keys(target).filter(id => id !== reserveId && target[id] > 0).map(id => minutes[id] ?? 0));
  const differences: Record<string, [number, number]> = Object.create(null);
  for (const [id, ratio] of Object.entries(target)) {
    if (id === reserveId || !ratio || !total) continue;
    const actual = minutes[id] ?? 0;
    differences[id] = [ratio * total - actual, ratio / (1 - target[reserveId]) * qualified - actual];
  }
  return {
    records, minutes, days, total, budget, qualified, differences,
    crowded: total >= rules.sample && (total - qualified) / total >= Math.max(rules.crowding, term.reserve + rules.reserveMargin),
    rate: budget ? total / budget : null, remaining: budget === null ? null : Math.max(0, budget - total),
  };
}
export const passesGap = (gap: number, base: number) => gap + 1e-8 >= Math.max(rules.minGap, rules.proportionalGap * base);

export type Suggestion = { subjectId: string; action: string; reason: string; code: string; minutes?: number; evidenceId?: string };
const stages: Record<Exclude<Stage, 'vacation'>, [string, number]> = {
  normal: ['做一次章节短练或小摸底', 30],
  prepare: ['针对弱点做专项练习，关闭答案重推，次日闭卷重做，一周后试同类变式', 45],
  review: ['按考试范围覆盖薄弱点，再闭卷回忆', 45],
  sprint: ['用未见资料限时验收，再查漏', 60],
};

function training(data: DeskData, term: Term, clock: Clock, stage: Exclude<Stage, 'vacation'>, course: Course, useOldFocus = true) {
  const recent = data.academic.results.filter(result => result.termId === term.id && result.subjectId === course.subjectId &&
    result.day <= clock.day && dayDistance(result.day, clock.day) < rules.evidenceDays).sort((a, b) => b.at - a.at)[0];
  let [action, minutes] = stages[stage];
  if (course.mode === 'task') [action, minutes] = ['整理开卷资料或检查待交任务', 30];
  else if (course.mode === 'bank' && stage !== 'sprint') [action, minutes] = ['检查题库覆盖并做主动回忆', 30];
  else if (stage === 'prepare' && recent?.tags.includes('运算化简')) action = '独立做化简短练，关闭答案重推，次日闭卷复测';
  else if (stage === 'prepare' && recent?.tags.includes('程序追踪')) action = '手工推演短程序，遮住答案重做输出题';
  else if (stage === 'prepare' && recent?.tags.includes('借助提示')) action = '遮住答案重做，次日闭卷复测，一周后做同类变式';
  else if (recent?.tags.includes('公式提取') && stage !== 'sprint') action = '闭卷提取公式，再做一道应用短练';
  else if (recent?.tags.includes('时间不足') && stage !== 'sprint') action = '用少量题做短时限训练，记录卡住的位置';
  else if (useOldFocus && course.focus && stage === 'normal') action = course.focus;
  else if (stage === 'normal' && recent && ['阅读', '听力', '词汇', '翻译', '写作'].includes(recent.activity)) {
    action = '按' + recent.activity + '做一组短练，再回顾薄弱题型';
  }
  return { action, minutes };
}

export function recommend(data: DeskData, term: Term, clock: Clock, target: Vector): Suggestion | undefined {
  if (term.archived || !inTerm(clock.day, term)) return;
  const inputs = inputsOf(data);
  const { stage } = stageAt(inputs, term, clock);
  const { courses, schedule } = baselineAt(inputs, term, clock, data.academic.otherId);
  const pool = schedule.filter(item => {
    if (!outstanding(item) || (isExam(item) && !stillAhead(item, clock))) return false;
    const info = courses.find(entry => entry.course.subjectId === item.subjectId);
    return !inputs.archived.includes(item.subjectId) && (!info || info.eligible);
  });
  const urgent = pool.find(item => dayDistance(clock.day, item.day) <= rules.urgentDays);
  const support = (item: Scheduled, code: string, reason: string): Suggestion => ({
    subjectId: item.subjectId, code, reason, action: item.title, evidenceId: item.id,
  });
  if (urgent) return support(urgent, 'deadline', '已确认的截止临近或已逾期');
  if (stage === 'vacation') return;
  const next = data.academic.next;
  const nextInfo = courses.find(({ course }) => course.subjectId === next?.subjectId);
  if (next?.termId === term.id && next.day === clock.day && next.defer) return;
  if (next?.termId === term.id && next.day === clock.day && nextInfo?.eligible &&
      !inputs.archived.includes(next.subjectId)) {
    return { subjectId: next.subjectId, ...training(data, term, clock, stage, nextInfo.course, false), code: 'manual', reason: '今日手动重点' };
  }
  const preparation = pool.find(item => !isExam(item) && clock.day >= (item.prepare || shiftDay(item.day, -rules.taskDays)));
  if (preparation) return { ...support(preparation, 'preparation', '已进入准备窗口'), minutes: 30 };
  const exam = pool.find(item => isExam(item) && dayDistance(clock.day, item.day) <= rules.examDays);
  if (exam) return support(exam, 'exam', '正式考核临近，安排考前检查');
  const summary = weeklyAllocation(data, term, monday(clock.day), clock, target);
  const latest = new Map<string, string>();
  for (const record of data.sessions) {
    if (inTerm(record.day, term) && record.day <= clock.day && record.day > (latest.get(record.subjectId) ?? '')) {
      latest.set(record.subjectId, record.day);
    }
  }
  const items = courses.filter(item => item.active).map(({ course, exam }) => {
    const last = latest.get(course.subjectId);
    const first = course.from || (course.mode === 'bank' && exam ? shiftDay(exam.day, -rules.bankDays) : term.from);
    return { course, last, idle: dayDistance(last || first, clock.day), gap: summary.differences[course.subjectId] };
  });
  const tie = (a: typeof items[number], b: typeof items[number]) =>
    Number(b.course.status === 'strengthen') - Number(a.course.status === 'strengthen') ||
    (b.idle - a.idle) || byId(courseId(a.course), courseId(b.course));
  const sampled = summary.total >= rules.sample && summary.qualified >= rules.sample;
  const deficit = sampled ? items.filter(item => item.gap &&
    passesGap(item.gap[0], summary.total) && passesGap(item.gap[1], summary.qualified))
    .sort((a, b) => Math.abs(b.gap![1] - a.gap![1]) < 1e-8 ? tie(a, b) : b.gap![1] - a.gap![1])[0] : undefined;
  const idle = items.filter(item => item.idle >= rules.idleDays).sort(tie)[0];
  const fallback = items.sort((a, b) => Number(b.course.status === 'strengthen') - Number(a.course.status === 'strengthen') ||
    Number(b.course.status === 'unassessed') - Number(a.course.status === 'unassessed') ||
    Number(!!b.course.focus) - Number(!!a.course.focus) || byId(courseId(a.course), courseId(b.course)))[0];
  const pick = deficit || idle || fallback;
  if (!pick) return;
  let { action, minutes } = training(data, term, clock, stage, pick.course);
  if (deficit) minutes = deficit.gap![1] < 30 ? 30 : deficit.gap![1] < 60 ? 45 : 60;
  return {
    subjectId: pick.course.subjectId, action, minutes, code: deficit ? 'gap' : idle ? 'idle' : 'focus',
    reason: deficit ? '本周校内投入低于当前目标' : idle ? (idle.last ? '距上次记录已至少四天' : '尚未记录这门课的投入')
      : sampled ? '当前分配无明显不足' : '本周样本不足，先完成一个训练单元',
  };
}

export function relevantPlan(data: DeskData, week: string) {
  const plan = data.plans.find(item => item.week === week);
  return plan ? { budget: targetsOf(plan)[0], updatedAt: plan.updatedAt } : null;
}

export const recentExam = (data: DeskData, term: Term, clock: Clock) => {
  const exam = scheduleOf(inputsOf(data), term).find(item => isExam(item) && outstanding(item) && stillAhead(item, clock));
  return exam && { ...exam, distance: dayDistance(clock.day, exam.day) };
};
