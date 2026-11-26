import { migrateStudy, type DeskData } from '../academic/model.ts';
import { reconcileUpdate, settle } from '../academic/review.ts';
import { validAcademic } from '../academic/validation.ts';
import {
  emptyData, examStatusNames, importanceNames, masteryNames, phases, qualityFor, tracks,
  type Split, type StudyData,
} from './model.ts';
import { prepareStudyMigration } from './handoff.ts';
import { daysOf, monday, validClock, validDay, validTimezone } from './time.ts';

const version = 2;
const schemaVersion = 2;
export const backupLimit = 64 * 1024 * 1024;
export const channelName = 'hikari-study-dashboard';
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
  return { format, version: 'academic' in data ? version : 1, data };
}

function decode(input: unknown): DeskData {
  if (!object(input) || input.format !== format) throw new Error('此文件不是学习工作台备份。');
  if (input.version !== 1 && input.version !== version) throw new Error('此数据版本与当前工作台不兼容。');
  if (!validData(input.data)) throw new Error('备份内容不完整，或包含无效的日期、预算和记录。');
  if (input.version === 1) return migrateStudy(input.data);
  if (!validAcademic((input.data as DeskData).academic, input.data, validData)) {
    throw new Error('备份的学业数据不完整，或包含无效的关联。');
  }
  return input.data as DeskData;
}

function backupJson(data: StudyData) {
  return JSON.stringify({ ...serialize(data), exportedAt: new Date().toISOString() }, null, 2);
}

function checkBackupSize(size: number) {
  if (size > backupLimit) throw new Error('备份超过 64 MiB，无法导出或恢复。');
}

export function exportBackup(data: StudyData) {
  const text = backupJson(data);
  checkBackupSize(new Blob([text]).size);
  return text;
}

export function exportBackupBlob(data: StudyData) {
  const file = new Blob([backupJson(data)], { type: 'application/json' });
  checkBackupSize(file.size);
  return file;
}

export function importBackup(text: string) {
  checkBackupSize(new Blob([text]).size);
  return parseBackup(text);
}

export async function importBackupFile(file: Blob) {
  checkBackupSize(file.size);
  return parseBackup(await file.text());
}

function parseBackup(text: string) {
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
  read(): Promise<DeskData>;
  update(change: (data: DeskData) => void, now?: number): Promise<DeskData>;
  restore(expected: DeskData, backup: DeskData, now?: number): Promise<DeskData>;
  close(): void;
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function requireCurrent(current: unknown, original: unknown) {
  if (!same(current, original)) throw new Error('此项在另一个窗口已变更，请重新打开后重试。');
}

export class LegacyStudyUpgradeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : '旧版学习工作台数据升级失败。', { cause });
  }
}

export function readLegacyStudy(): Promise<StudyData> {
  return new Promise((resolve, reject) => {
    // Opening an explicit version rejects a v2 database. Abort if no database exists.
    const request = indexedDB.open(channelName, 1);
    request.onupgradeneeded = () => request.transaction!.abort();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      try {
        const transaction = database.transaction('state', 'readonly');
        const read = transaction.objectStore('state').get('current');
        transaction.oncomplete = () => {
          const input: unknown = read.result;
          if (object(input) && input.format === format && input.version === 1 &&
              validData(input.data) && !('academic' in input.data)) resolve(input.data);
          else reject(new Error('无法校验旧版学习工作台快照。'));
        };
        transaction.onabort = () => reject(transaction.error ?? new Error('旧版学习工作台读取中断。'));
      } catch (error) {
        reject(error);
      } finally {
        // Let the readonly transaction finish without holding the version open.
        database.close();
      }
    };
  });
}

export async function openStudyRepository(recovery?: DeskData): Promise<StudyRepository> {
  if (recovery) assertValid(recovery);
  await prepareStudyMigration(channelName, schemaVersion);
  let recoveredDuringUpgrade = false;
  function recover(store: IDBObjectStore, previous: unknown, error: unknown) {
    if (!recovery || (object(previous) && typeof previous.version === 'number' && previous.version > version)) throw error;
    if (previous !== undefined) store.put(previous, 'recovery-' + crypto.randomUUID());
    const data = structuredClone(recovery);
    settle(data, Date.now());
    return data;
  }
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(channelName, schemaVersion);
    let cancelled = false;
    let upgradingLegacy = false;
    let cause: unknown;
    request.onupgradeneeded = event => {
      const transaction = request.transaction!;
      if (cancelled) {
        transaction.abort();
        return;
      }
      upgradingLegacy = event.oldVersion === 1;
      const store = event.oldVersion === 0 ? request.result.createObjectStore('state') : transaction.objectStore('state');
      const old = store.get('current');
      old.onsuccess = () => {
        try {
          let data: DeskData;
          try {
            data = old.result === undefined ? migrateStudy(emptyData()) : decode(old.result);
          } catch (error) {
            data = recover(store, old.result, error);
            recoveredDuringUpgrade = true;
          }
          assertValid(data);
          const write = store.put(serialize(data), 'current');
          write.onerror = () => { cause = write.error; };
        } catch (error) {
          cause = error;
          transaction.abort();
        }
      };
    };
    request.onsuccess = () => {
      if (cancelled) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => {
      const error = cause ?? request.error;
      reject(upgradingLegacy ? new LegacyStudyUpgradeError(error) : error);
    };
    request.onblocked = () => {
      cancelled = true;
      reject(new Error('数据库升级被其他窗口占用。请关闭旧窗口后重试。'));
    };
  });
  database.onversionchange = () => database.close();

  function transact(change?: (data: DeskData) => void, restore?: { expected: DeskData; backup: DeskData }, at?: number,
    recoverInvalid = false) {
    return new Promise<DeskData>((resolve, reject) => {
      const transaction = database.transaction('state', 'readwrite');
      const store = transaction.objectStore('state');
      const request = store.get('current');
      let result: DeskData;
      let write = false;
      request.onsuccess = () => {
        try {
          const now = at ?? Date.now();
          let original: string | undefined;
          try {
            if (request.result === undefined) throw new Error('本地数据缺少主记录，请检查或恢复备份。');
            result = decode(request.result);
            original = JSON.stringify(result);
          } catch (error) {
            if (!recoverInvalid) throw error;
            result = recover(store, request.result, error);
          }
          if (recoverInvalid && original !== undefined) throw new Error('本地数据可正常读取。请用设置中的恢复入口预览覆盖。');
          settle(result, now);
          if (restore) {
            requireCurrent(result, restore.expected);
            if (result.timer && !same(result.timer, restore.backup.timer)) {
              throw new Error('当前有未结算的计时。请先保存或放弃，再恢复备份。');
            }
            result = structuredClone(restore.backup);
            settle(result, now);
          } else if (change) {
            const before = structuredClone(result);
            change(result);
            reconcileReferences(before, result);
            reconcileUpdate(before, result, now);
          }
          write = JSON.stringify(result) !== original;
          if (write) {
            assertValid(result);
            store.put(serialize(result), 'current');
          }
        } catch (error) {
          reject(error);
          transaction.abort();
        }
      };
      transaction.oncomplete = () => {
        if (write && typeof BroadcastChannel === 'function') {
          const channel = new BroadcastChannel(channelName);
          channel.postMessage('changed');
          channel.close();
        }
        resolve(result);
      };
      transaction.onabort = () => reject(transaction.error ?? new Error('本次保存未完成。'));
      transaction.onerror = () => reject(transaction.error);
    });
  }
  if (recovery && !recoveredDuringUpgrade) {
    try {
      await transact(undefined, undefined, undefined, true);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  return {
    read: () => transact(),
    update: (change, now) => transact(change, undefined, now),
    restore: (expected, backup, now) => transact(undefined, { expected, backup }, now),
    close: () => database.close(),
  };
}

function assertValid(data: DeskData) {
  if (!validData(data) || !validAcademic(data.academic, data, validData)) throw new Error('数据无效，请检查日期、范围及关联。');
}

function reconcileReferences(before: DeskData, data: DeskData) {
  for (const result of data.academic.results) {
    if (result.sessionId && !data.sessions.some(item => item.id === result.sessionId &&
      item.subjectId === result.subjectId && item.day === result.day) &&
      before.academic.results.some(item => item.id === result.id && item.sessionId === result.sessionId &&
        item.subjectId === result.subjectId && item.day === result.day)) result.sessionId = '';
  }
  const removed = new Set<string>();
  for (const assessment of data.academic.assessments) {
    if (!assessment.examId) continue;
    const exam = data.exams.find(item => item.id === assessment.examId);
    const term = data.academic.terms.find(item => item.id === assessment.termId);
    if (!exam || !term || exam.subjectId !== assessment.subjectId || exam.day < term.from || exam.day > term.through) {
      if (before.academic.assessments.some(item => item.id === assessment.id && item.examId === assessment.examId)) removed.add(assessment.id);
    } else {
      assessment.day = exam.day;
      assessment.status = exam.status;
    }
  }
  data.academic.assessments = data.academic.assessments.filter(item => !removed.has(item.id));
  for (const term of data.academic.terms) {
    for (const course of term.courses) {
      const old = before.academic.terms.find(item => item.id === term.id)?.courses.find(item => item.subjectId === course.subjectId);
      if (!course.checklist || !old?.checklist) continue;
      const signature = (state: DeskData) => state.academic.assessments.filter(item => item.termId === term.id &&
        item.subjectId === course.subjectId && item.required).map(item =>
        [item.id, item.examId, item.status === 'cancelled', item.certainty]).sort();
      if (!same(signature(before), signature(data))) course.checklist = null;
    }
  }
}
