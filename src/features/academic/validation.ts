import { monday, validClock, validDay } from '../study/time.ts';
import { importanceNames, masteryNames, type StudyData } from '../study/model.ts';
import { attempts, conditions, materialStates, metrics, modes, reserveId, stages, states } from './model.ts';

type Row = Record<string, unknown>;
export const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
export const array = (value: unknown, valid: (item: unknown) => boolean) =>
  Array.isArray(value) && value.length <= 100_000 && value.every(valid);
export const text = (value: unknown, max = 2000): value is string => typeof value === 'string' && value.length <= max;
export const key = (value: unknown): value is string => text(value, 100) && /^[\w-]+$/.test(value);
export const choice = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value);
export const date = (value: unknown): value is string => typeof value === 'string' && validDay(value);
export const dateOrEmpty = (value: unknown) => value === '' || date(value);
export const time = (value: unknown) => value === '' || typeof value === 'string' && validClock(value);
export const num = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
export const stamp = (value: unknown): value is number => num(value, 1, 253370764799999) && Number.isSafeInteger(value);
export const week = (value: unknown) => date(value) && monday(value) === value;
const bool = (value: unknown) => typeof value === 'boolean';
const unique = (items: unknown[], field: string) => new Set(items.map(item => (item as Row)[field])).size === items.length;
const keyed = (value: unknown, validate: (item: Row) => boolean, field = 'id'): value is Row[] =>
  Array.isArray(value) && array(value, item => object(item) && key(item[field]) && validate(item)) && unique(value, field);
const optional = (value: unknown, min: number, max: number) => value === null || num(value, min, max);
const labeled = (value: unknown, max = 120) => text(value, max) && !!value.trim();

export const vector = (value: unknown) => object(value) && Object.keys(value).length > 1 && Object.hasOwn(value, reserveId) &&
  Object.entries(value).every(([id, ratio]) => (id === reserveId || key(id)) && num(ratio, 0, 1)) &&
  Math.abs(Object.values(value).reduce<number>((sum, ratio) => sum + Number(ratio), 0) - 1) < 1e-8 &&
  num(value[reserveId], 0, .2);

const assessmentKinds = ['exam', 'assignment', 'online', 'oral', 'diagnostic', 'preparation'];
const investmentStates = ['low', 'enough', 'unknown'];
const adjustmentStates = ['pending', 'applied', 'invalid', 'paused', 'rejected'];
const examStates = ['scheduled', 'completed', 'cancelled'];
const certaintyStates = ['confirmed', 'tentative', 'unknown'];

export function validAcademic(value: unknown, data: StudyData, validStudy: (value: unknown) => boolean) {
  const school = new Set(data.subjects.filter(item => item.track === 'school').map(item => item.id));
  const subject = (id: unknown) => key(id) && school.has(id);
  const course = (item: Row) => subject(item.subjectId) && choice(item.mode, modes) && choice(item.status, states) &&
    choice(item.activation, ['auto', 'on', 'off']) && bool(item.disabled) &&
    optional(item.credits, Number.MIN_VALUE, 10_000) && optional(item.finalShare, 0, 1) &&
    optional(item.cost, .25, 2) && optional(item.goal, 0, 1) && optional(item.coverageGoal, 0, 1) &&
    dateOrEmpty(item.from) && dateOrEmpty(item.through) &&
    !(item.from && item.through && String(item.from) > String(item.through)) &&
    [item.strategy, item.focus, item.focus2].every(textValue => text(textValue)) &&
    (item.checklist === null || array(item.checklist, key) &&
      new Set(item.checklist as string[]).size === (item.checklist as string[]).length);
  function terms(value: unknown): value is Row[] {
    if (!keyed(value, item => labeled(item.name) && date(item.from) && date(item.through) && item.from <= item.through &&
      bool(item.archived) && (item.examWeek === '' || week(item.examWeek)) && num(item.reserve, 0, .2) &&
      (item.override === '' || choice(item.override, stages)) &&
      keyed(item.courses, course, 'subjectId') &&
      (item.manual === null || vector(item.manual) && (item.manual as Row)[reserveId] === item.reserve &&
        Object.keys(item.manual as Row).every(id => id === reserveId || (item.courses as Row[]).some(candidate => candidate.subjectId === id))) &&
      keyed(item.routes, route => date(route.from) && date(route.through) && route.from <= route.through &&
        route.from >= String(item.from) && route.through <= String(item.through) &&
        choice(route.stage, stages) && text(route.label) && text(route.focus)))) return false;
    const ordered = [...value].sort((a, b) => String(a.from).localeCompare(String(b.from)));
    return ordered.every((item, index) => index === 0 || String(ordered[index - 1].through) < String(item.from));
  }
  function assessments(items: unknown, current: Row[], exams: StudyData['exams']) {
    if (!keyed(items, item => subject(item.subjectId) && current.some(term => term.id === item.termId &&
      (!item.day || String(term.from) <= String(item.day) && String(term.through) >= String(item.day))) &&
      choice(item.kind, assessmentKinds) && choice(item.certainty, certaintyStates) && choice(item.status, examStates) &&
      labeled(item.title) && dateOrEmpty(item.day) && time(item.time) && dateOrEmpty(item.prepare) &&
      !(item.prepare && item.day && String(item.prepare) > String(item.day)) &&
      (item.certainty === 'unknown' ? item.day === '' : date(item.day)) && bool(item.required) &&
      (item.examId === '' || (item.kind === 'exam' && item.certainty === 'confirmed' &&
        exams.some(exam => exam.id === item.examId && exam.subjectId === item.subjectId))) &&
      !(item.kind === 'exam' && item.certainty === 'confirmed' && !item.examId) &&
      (item.examDraft === undefined || object(item.examDraft) && item.kind === 'exam' && !item.examId &&
        key(item.examDraft.id) && time(item.examDraft.start) && choice(item.examDraft.importance, Object.keys(importanceNames)) &&
        choice(item.examDraft.mastery, Object.keys(masteryNames)) && text(item.examDraft.note) &&
        (item.examDraft.closedAt === undefined || stamp(item.examDraft.closedAt))))) return false;
    const reserved = new Set(exams.map(exam => exam.id));
    const assessmentIds = new Set(items.map(item => item.id));
    for (const item of items) {
      if (!object(item.examDraft)) continue;
      const id = String(item.examDraft.id);
      if (reserved.has(id) || id !== item.id && assessmentIds.has(id)) return false;
      reserved.add(id);
    }
    const linked = items.filter(item => item.examId);
    return unique(linked, 'examId') && !items.some(item => !item.examId && exams.some(exam => exam.id === item.id));
  }

  function config(item: unknown) {
    return object(item) && terms(item.terms) &&
      validStudy({ ...data, settings: item.settings, exams: item.exams, plans: [], sessions: [], timer: null, reviews: [] }) &&
      assessments(item.assessments, item.terms, item.exams as StudyData['exams']) && array(item.school, subject) && array(item.archived, subject);
  }
  const versions = (items: unknown) => array(items, item => object(item) && stamp(item.at) && config(item.inputs)) &&
    (items as Row[]).every((item, index, all) => !index || Number(item.at) >= Number(all[index - 1].at));
  const resultCore = (item: Row) => key(item.id) && subject(item.subjectId) && date(item.day) && stamp(item.at) &&
    labeled(item.activity) && choice(item.metric, metrics) && text(item.scope, 120) && text(item.difficulty, 80) &&
    choice(item.condition, conditions) && choice(item.attempt, attempts) &&
    (item.metric === 'done' ? item.value === null && item.total === null :
      num(item.total, Number.MIN_VALUE, 100_000) && num(item.value, 0, item.total) &&
      (['score', 'official'].includes(String(item.metric)) ||
        Number.isInteger(item.total) && Number.isInteger(item.value)));
  if (!object(value) || !subject(value.otherId) || !terms(value.terms) ||
      !assessments(value.assessments, value.terms, data.exams) ||
      !array(value.aliases, item => object(item) && subject(item.subjectId) && labeled(item.name)) ||
      !versions(value.versions)) return false;
  const current = value.terms;
  const termFor = (item: Row) => current.find(term => term.id === item.termId);
  if (value.currentTerm !== '' && !current.some(item => item.id === value.currentTerm && !item.archived)) return false;
  if (!keyed(value.results, item => {
    const term = termFor(item);
    return !!term && String(item.day) >= String(term.from) && String(item.day) <= String(term.through) && resultCore(item) &&
      (item.prompted === null || item.metric === 'independent' && num(item.prompted, 0, Number(item.total) - Number(item.value)) &&
        Number.isInteger(item.prompted)) && array(item.tags, tag => text(tag, 40)) && text(item.note) &&
      (item.sessionId === '' || data.sessions.some(session => session.id === item.sessionId &&
        session.subjectId === item.subjectId && session.day === item.day));
  }) || !keyed(value.materials, item => !!termFor(item) && subject(item.subjectId) && labeled(item.title) &&
    text(item.location) && text(item.note) && choice(item.use, materialStates))) return false;
  if (!(value.next === null || object(value.next) && termFor(value.next) && subject(value.next.subjectId) &&
    date(value.next.day) && text(value.next.action) && bool(value.next.defer) && (value.next.defer || labeled(value.next.action, 2000)))) return false;

  const applied = new Set<string>();
  const pending = new Set<string>();
  return array(value.adjustments, adjustment => {
    if (!object(adjustment) || !object(adjustment.proposal) || !stamp(adjustment.confirmedAt) ||
      !choice(adjustment.state, adjustmentStates) || !text(adjustment.reason) ||
      !(adjustment.appliedAt === null || stamp(adjustment.appliedAt)) ||
      !(adjustment.endedAt === null || stamp(adjustment.endedAt))) return false;
    const p = adjustment.proposal;
    if (!termFor(p) || !week(p.week) || !week(p.inputWeek) || !stamp(p.effectiveAt) || !stamp(p.asOf) ||
      !Number.isSafeInteger(p.rule) || !text(p.baseline, 1_000_000) || !text(p.fingerprint, 8_000_000) ||
      !vector(p.before) || !vector(p.after) || !config(p.config) || !versions(p.inputConfig) ||
      !optional(p.budget, 0, 10080) || !object(p.evidence)) return false;
    const before = p.before as Record<string, number>;
    const after = p.after as Record<string, number>;
    if (Object.keys(before).length !== Object.keys(after).length || before[reserveId] !== after[reserveId] ||
      !Object.keys(before).every(id => id === reserveId || subject(id) && Math.abs(before[id] - after[id]) <= .03000001)) return false;
    const a = p.evidence;
    if (!subject(a.subjectId) || !Array.isArray(a.pair) || a.pair.length !== 2 ||
      !a.pair.every(item => object(item) && resultCore(item) && item.subjectId === a.subjectId) ||
      a.pair[0].day >= a.pair[1].day || !num(a.count, 2, 100_000) || !num(a.goal, 0, 1) ||
      !num(a.minutes, 0, Number.MAX_SAFE_INTEGER) || !optional(a.planned, 0, 10080) ||
      !choice(a.investment, investmentStates) || !choice(a.direction, ['increase', 'decrease']) ||
      !(a.gaps === null || Array.isArray(a.gaps) && a.gaps.length === 2 && a.gaps.every(gap => num(gap, -1e9, 1e9)))) return false;
    const id = p.termId + ':' + p.week;
    const active = adjustment.state === 'applied' || adjustment.state === 'paused';
    if (active !== (adjustment.appliedAt !== null) ||
      (adjustment.state === 'invalid' || adjustment.state === 'paused') !== (adjustment.endedAt !== null)) return false;
    if (active || adjustment.state === 'pending') {
      if (applied.has(id) || pending.has(id)) return false;
      (active ? applied : pending).add(id);
    }
    return true;
  });
}
