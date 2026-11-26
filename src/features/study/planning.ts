import { type Budget, type Exam, type Phase, type Settings, type Split, type Timer } from './model.ts';
import { clockMinute, dayDistance, daysOf, localClock } from './time.ts';

export type LocalTime = ReturnType<typeof localClock>;

export const untimedCutoff = (settings: Settings) =>
  ({ endOfDay: 1440, midday: 720, startOfDay: 0 })[settings.untimedExam];

export function examCutoff(exam: Exam, settings: Settings) {
  if (exam.end) return clockMinute(exam.end);
  const fallback = untimedCutoff(settings);
  return Math.max(exam.start ? clockMinute(exam.start) + 1 : 0, fallback);
}

export function isUpcoming(exam: Exam, time: LocalTime, settings: Settings) {
  return exam.status === 'scheduled' &&
    (exam.day > time.day || (exam.day === time.day && time.minute < examCutoff(exam, settings)));
}

export function upcomingExams(exams: Exam[], time: LocalTime, settings: Settings) {
  return exams.filter(exam => isUpcoming(exam, time, settings)).sort((a, b) =>
    a.day.localeCompare(b.day) || (a.start || a.end || '24:00').localeCompare(b.start || b.end || '24:00'));
}

export function phaseAt(exams: Exam[], time: LocalTime, settings: Settings) {
  const exam = upcomingExams(exams, time, settings).find(item => item.importance === 'important');
  const distance = exam ? dayDistance(time.day, exam.day) : Infinity;
  const automatic: Phase = distance <= 3 ? 'sprint' : distance <= 14 ? 'review'
    : distance <= 28 ? 'prepare' : settings.vacation ? 'vacation' : 'normal';
  return { exam, distance, automatic, phase: settings.override === 'auto' ? automatic : settings.override };
}

function apportion(weights: Split, divisor: number, total: number): Split {
  const result = weights.map(weight => Math.floor(weight / divisor)) as Split;
  const order = [0, 1, 2].sort((a, b) => (weights[b] % divisor) - (weights[a] % divisor));
  const missing = total - result.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < missing; index++) result[order[index]]++;
  return result;
}

export function calculateBudget(week: string, minutes: number[], beforeExam: (number | null)[], exams: Exam[], settings: Settings): Budget {
  // A manually completed exam still explains the historical part of its current week.
  const schedule = exams.flatMap(exam => {
    if (exam.status !== 'completed' || exam.closedAt === undefined) return [exam];
    const end = localClock(exam.closedAt, settings.timezone);
    if (end.day > exam.day) return [{ ...exam, status: 'scheduled' as const }];
    if (end.day < exam.day) return [];
    const cutoff = Math.min(end.minute, examCutoff(exam, settings));
    const clock = `${String(Math.floor(cutoff / 60)).padStart(2, '0')}:${String(cutoff % 60).padStart(2, '0')}`;
    return [{ ...exam, end: clock, status: 'scheduled' as const }];
  });
  const days = daysOf(week).map((day, index) => {
    const start = phaseAt(schedule, { day, minute: 0 }, settings).phase;
    const lastExam = schedule.filter(exam => exam.importance === 'important' && exam.day === day && exam.status === 'scheduled')
      .reduce((last, exam) => Math.max(last, examCutoff(exam, settings)), 0);
    const end = phaseAt(schedule, { day, minute: lastExam }, settings).phase;
    if (start === end) return { day, parts: [{ phase: start, minutes: minutes[index] }] };
    // With no exact study schedule, estimate the split over waking hours, 08:00–22:00.
    const fraction = Math.min(1, Math.max(0, (lastExam - 480) / 840));
    const before = Math.min(minutes[index], beforeExam[index] ?? Math.round(minutes[index] * fraction));
    return { day, parts: [{ phase: start, minutes: before }, { phase: end, minutes: minutes[index] - before }] };
  });
  const available = minutes.reduce((sum, value) => sum + value, 0);
  const reserve = Math.round(available * settings.buffer / 100);
  const allocatable = available - reserve;
  const weights: Split = [0, 0, 0];
  const distributablePercent = 100 - settings.buffer;
  for (const day of days) {
    for (const part of day.parts) {
      settings.ratios[part.phase].forEach((ratio, index) => {
        weights[index] += part.minutes * distributablePercent * ratio;
      });
    }
  }
  // Keep exact integer numerators for the two percentages. Round only the week totals.
  return { available, reserve, allocatable, targets: apportion(weights, 10_000, allocatable), days };
}

export const timerMs = (timer: Timer, now: number) =>
  timer.elapsedMs + (timer.runningSince === null ? 0 : Math.max(0, now - timer.runningSince));
