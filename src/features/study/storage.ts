import {
  emptyData, examStatusNames, importanceNames, masteryNames, phases, qualityFor, tracks,
  type Split, type StudyData,
} from './model.ts';
import { daysOf, monday, validClock, validDay, validTimezone } from './time.ts';

const version = 1;
const format = 'hikari-study-dashboard';
type Envelope = { format: typeof format; version: number; data: StudyData };
type Input = Record<string, unknown>;
const object = (value: unknown): value is Input => !!value && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown, validate: (item: unknown) => boolean, length?: number): value is unknown[] =>
  Array.isArray(value) && (length === undefined || value.length === length) && value.every(validate);
const integer = (value: unknown, max: number, min = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const string = (value: unknown, max = 2000): value is string => typeof value === 'string' && value.length <= max;
const name = (value: unknown) => string(value, 120) && value.trim().length > 0;
const id = (value: unknown): value is string => string(value, 100) && /^[a-zA-Z0-9_-]+$/.test(value);
const day = (value: unknown): value is string => typeof value === 'string' && validDay(value);
const week = (value: unknown): value is string => day(value) && monday(value) === value && daysOf(value).every(validDay);
const time = (value: unknown) => value === '' || (typeof value === 'string' && validClock(value));
const dateMs = (value: unknown): value is number => integer(value, 253370764799999, 1);
const choice = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value);
const unique = (items: unknown[], key: string) => new Set(items.map(item => (item as Input)[key])).size === items.length;
const sum = (items: number[]) => items.reduce((total, value) => total + value, 0);
const split = (value: unknown, max: number): value is Split => list(value, item => integer(item, max), 3);

function validSettings(value: unknown) {
  return object(value) && string(value.timezone, 100) && validTimezone(value.timezone) &&
    integer(value.buffer, 100) && choice(value.override, [...phases, 'auto']) && typeof value.vacation === 'boolean' &&
    choice(value.untimedExam, ['endOfDay', 'midday', 'startOfDay']) && object(value.ratios) &&
    phases.every(phase => {
      const ratio = (value.ratios as Input)[phase];
      return split(ratio, 100) && sum(ratio) === 100;
    });
}

function validPlan(value: unknown) {
  if (!object(value) || !week(value.week) || !list(value.minutes, item => integer(item, 1440), 7) ||
    !list(value.beforeExam, item => item === null || integer(item, 1440), 7) || !object(value.budget) ||
    !integer(value.revision, Number.MAX_SAFE_INTEGER, 1) || !dateMs(value.updatedAt) || !string(value.focus)) return false;
  const minutes = value.minutes as number[];
  const available = sum(minutes);
  const budget = value.budget;
  if (budget.available !== available || !integer(budget.reserve, available) ||
    budget.allocatable !== available - budget.reserve || !split(budget.targets, available) ||
    sum(budget.targets) !== budget.allocatable ||
    (value.manual !== null && (!split(value.manual, available) || sum(value.manual) !== budget.allocatable)) ||
    (value.previousTargets !== null && !split(value.previousTargets, 10080))) return false;
  if (!list(budget.days, item => object(item) && day(item.day) && list(item.parts, part =>
    object(part) && choice(part.phase, phases) && integer(part.minutes, 1440)) &&
    item.parts.length >= 1 && item.parts.length <= 2, 7)) return false;
  const dates = daysOf(value.week);
  return budget.days.every((item, index) => {
    const daily = item as { day: string; parts: { minutes: number }[] };
    return daily.day === dates[index] && sum(daily.parts.map(part => part.minutes)) === minutes[index];
  });
}

function validData(value: unknown): value is StudyData {
  if (!object(value) || !validSettings(value.settings) ||
    !list(value.subjects, subject => object(subject) && id(subject.id) && name(subject.name) &&
      choice(subject.track, tracks) && typeof subject.archived === 'boolean') || !unique(value.subjects, 'id')) return false;
  const subjects = new Map((value.subjects as StudyData['subjects']).map(subject => [subject.id, subject]));
  const validSubjectId = (item: unknown) => id(item) && subjects.has(item);
  return list(value.exams, exam => object(exam) && id(exam.id) && name(exam.name) && validSubjectId(exam.subjectId) &&
    day(exam.day) && time(exam.start) && time(exam.end) && (!exam.start || !exam.end || String(exam.start) < String(exam.end)) &&
    choice(exam.importance, Object.keys(importanceNames)) && choice(exam.mastery, Object.keys(masteryNames)) &&
    choice(exam.status, Object.keys(examStatusNames)) && (exam.closedAt === undefined || dateMs(exam.closedAt)) &&
    string(exam.note)) && unique(value.exams, 'id') &&
    list(value.plans, validPlan) && unique(value.plans, 'week') &&
    list(value.sessions, session => object(session) && id(session.id) && day(session.day) && validSubjectId(session.subjectId) &&
      integer(session.minutes, 1440, 1) && (session.quality === '' ||
        choice(session.quality, qualityFor(subjects.get(session.subjectId as string)!.track))) &&
      string(session.note)) && unique(value.sessions, 'id') &&
    (value.timer === null || (object(value.timer) && id(value.timer.id) && day(value.timer.day) &&
      validSubjectId(value.timer.subjectId) && dateMs(value.timer.startedAt) && integer(value.timer.elapsedMs, Number.MAX_SAFE_INTEGER) &&
      (value.timer.runningSince === null || (dateMs(value.timer.runningSince) && value.timer.runningSince >= value.timer.startedAt)) &&
      !(value.sessions as StudyData['sessions']).some(session => session.id === (value.timer as Input).id))) &&
    list(value.reviews, review => object(review) && week(review.week) &&
      [review.balance, review.knowledge, review.results, review.issues, review.nextFocus].every(field => string(field))) &&
    unique(value.reviews, 'week');
}

function serialize(data: StudyData): Envelope {
  return { format, version, data };
}

function decode(input: unknown): StudyData {
  if (!object(input) || input.format !== format) throw new Error('此文件不是学习工作台备份。');
  if (input.version !== version) throw new Error('此数据版本与当前工作台不兼容。');
  if (!validData(input.data)) throw new Error('备份内容不完整，或包含无效的日期、预算和记录。');
  return input.data;
}

export function exportBackup(data: StudyData) {
  return JSON.stringify({ ...serialize(data), exportedAt: new Date().toISOString() }, null, 2);
}
export function importBackup(text: string) {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('无法读取 JSON，请选择学习工作台导出的文件。');
  }
  if (object(input) && input.format === format && (!string(input.exportedAt, 40) || !Number.isFinite(Date.parse(input.exportedAt)))) {
    throw new Error('备份缺少有效的导出时间。');
  }
  return decode(input);
}

export interface StudyRepository {
  read(): Promise<StudyData>;
  update(change: (data: StudyData) => StudyData | void): Promise<StudyData>;
}

export async function openStudyRepository(): Promise<StudyRepository> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('hikari-study-dashboard', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他学习工作台窗口再重试。'));
  });
  database.onversionchange = () => database.close();
  function transact(change?: (data: StudyData) => StudyData | void) {
    return new Promise<StudyData>((resolve, reject) => {
      const transaction = database.transaction('state', change ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('state');
      const request = store.get('current');
      let result: StudyData;
      request.onsuccess = () => {
        try {
          result = request.result === undefined ? emptyData() : decode(request.result);
          if (change) {
            result = change(result) ?? result;
            if (!validData(result)) throw new Error('请检查填写的数据。');
            store.put(serialize(result), 'current');
          }
        } catch (error) {
          reject(error);
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error('本次保存未完成。'));
      transaction.onerror = () => reject(transaction.error);
    });
  }
  return { read: () => transact(), update: change => transact(change) };
}
