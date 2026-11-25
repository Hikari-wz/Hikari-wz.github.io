import { type Budget, type Session, type Split, type StudyData, type WeeklyPlan, phaseNames, trackNames, tracks } from './model.ts';
import { daysOf, duration, monday, shiftDay } from './time.ts';
import type { LocalTime } from './planning.ts';

export function summarize(data: StudyData, sessions: Session[]) {
  const subjects = new Map(data.subjects.map(subject => [subject.id, subject]));
  const actual: Split = [0, 0, 0];
  const bySubject = new Map<string, number>();
  const byQuality = new Map<string, number>();
  for (const session of sessions) {
    const subject = subjects.get(session.subjectId);
    if (!subject) continue;
    actual[tracks.indexOf(subject.track)] += session.minutes;
    bySubject.set(subject.id, (bySubject.get(subject.id) ?? 0) + session.minutes);
    if (session.quality) byQuality.set(session.quality, (byQuality.get(session.quality) ?? 0) + 1);
  }
  const total = actual.reduce((sum, value) => sum + value, 0);
  return {
    actual, total, byQuality, sessions,
    subjects: [...bySubject].sort((a, b) => b[1] - a[1]).map(([id, minutes]) => ({ ...subjects.get(id)!, minutes })),
  };
}

export const weekSessions = (data: StudyData, week: string) =>
  data.sessions.filter(session => session.day >= week && session.day <= shiftDay(week, 6));
export const targetsOf = (plan: WeeklyPlan) => plan.manual ?? plan.budget.targets;
export const percent = (part: number, total: number) => total > 0 ? Math.round(part * 100 / total) : null;
export function remainingAvailable(plan: WeeklyPlan, sessions: Session[], time: LocalTime) {
  return daysOf(plan.week).reduce((total, day, index) => {
    if (day < time.day) return total;
    const spent = sessions.filter(session => session.day === day).reduce((sum, session) => sum + session.minutes, 0);
    return total + Math.max(0, plan.minutes[index] - spent);
  }, 0);
}

export function guidance(data: StudyData, time: LocalTime, phase: keyof typeof phaseNames, plan?: WeeklyPlan) {
  const sessions = weekSessions(data, monday(time.day)).filter(session => session.day <= time.day);
  const stats = summarize(data, sessions);
  const messages: string[] = [];
  const hinted = stats.byQuality.get('借助提示完成') ?? 0;
  if (hinted >= 3) messages.push('近期有多次练习借助了提示。可以挑一道做过的题，安排一次独立重做。');
  if (!plan) return { messages, next: '先设置本周可用时间，再安排三类学习。' };

  const targets = targetsOf(plan);
  const remaining = targets.map((target, index) => Math.max(0, target - stats.actual[index]));
  if (plan.budget.allocatable > 0 && remaining.every(value => value === 0)) {
    return { messages, next: '本周目标已全部完成，可以自由安排剩余时间。' };
  }

  const plannedDays = data.plans.flatMap(saved => daysOf(saved.week)
    .filter((day, index) => day < time.day && saved.minutes[index] > 0)).sort().slice(-3);
  const earliest = plannedDays[0];
  const trackedSelf = data.sessions.some(session => session.day >= earliest && session.day < time.day &&
    data.subjects.find(subject => subject.id === session.subjectId)?.track === 'self');
  if (targets[1] > 0 && plannedDays.length === 3 && plannedDays[2] >= shiftDay(time.day, -7) && !trackedSelf) {
    messages.push('最近三个已过的计划学习日没有自主学习记录，可以留出一小段时间接续。');
  }

  const elapsedDays = daysOf(plan.week).filter((day, index) => day < time.day && plan.minutes[index] > 0).length;
  if (elapsedDays >= 2 && sessions.length >= 3 && stats.total >= 90) {
    const mismatches = tracks.filter((_, index) => plan.budget.allocatable > 0 &&
      Math.abs(stats.actual[index] / stats.total - targets[index] / plan.budget.allocatable) > .05);
    if (mismatches.length) messages.push(`${mismatches.map(track => trackNames[track]).join('、')}的实际占比与目标相差超过 5 个百分点。`);
    if (phase !== 'sprint' && stats.subjects[0]?.minutes > stats.total / 2) {
      messages.push(`${stats.subjects[0].name}占本周投入一半以上，可以检查其它科目的安排。`);
    }
  }
  const free = remainingAvailable(plan, sessions, time);
  if (free < remaining.reduce((sum, value) => sum + value, 0)) {
    messages.push('按每天的计划估算，本周可用时间低于剩余目标，可以调整预算。');
  }
  const project = targets[2] ? stats.actual[2] * 100 / targets[2] : 0;
  if (stats.actual[2] > targets[2] && targets[1] > 0 && remaining[1] >= Math.max(30, targets[1] / 2) &&
    (elapsedDays >= 2 || free < remaining[1])) {
    messages.unshift('项目实践已超出预算，自主学习仍有明显缺口。可以先把下一段时间留给自主学习。');
  } else if (project >= 100 || (targets[2] === 0 && stats.actual[2] > 0 && plan.budget.allocatable > 0)) {
    messages.push('项目实践已用完本周预算，可以先检查另外两类目标。');
  } else if (project >= 80) {
    messages.push('项目实践已接近本周目标，可以留意剩余可用时间。');
  }
  const order = phase === 'sprint' || phase === 'review' ? [0, 1, 2] : [1, 0, 2];
  const next = order.find(index => remaining[index] > 0);
  return { messages, next: next === undefined ? '可以从一段短学习开始，或先为本周设置可用时间。'
    : `可以优先安排${trackNames[tracks[next]]}，本周还差 ${duration(remaining[next])}。` };
}

export function recordedWeeks(data: StudyData, current: string) {
  const dates = new Set([current, ...data.plans.map(plan => plan.week),
    ...data.sessions.map(session => monday(session.day)), ...data.reviews.map(review => review.week)]);
  return [...dates].sort().reverse();
}

export const budgetText = (value: Budget) => `可用 ${duration(value.available)} · 机动 ${duration(value.reserve)} · 可分配 ${duration(value.allocatable)}`;
