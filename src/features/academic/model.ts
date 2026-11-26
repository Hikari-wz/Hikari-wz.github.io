import type { Exam, Settings, StudyData } from '../study/model.ts';

export const modes = ['ability', 'bank', 'task'] as const;
export const states = ['unassessed', 'normal', 'strengthen', 'achieved', 'completed'] as const;
export const metrics = ['score', 'count', 'independent', 'coverage', 'done', 'official'] as const;
export const conditions = ['unknown', 'independent', 'materials', 'assisted'] as const;
export const attempts = ['unknown', 'first', 'repeat'] as const;
export const materialStates = ['unused', 'practice', 'sealed', 'mocked'] as const;
export const stages = ['normal', 'prepare', 'review', 'sprint', 'vacation'] as const;
export type Stage = typeof stages[number];
export type Vector = Record<string, number>;
export const reserveId = '@reserve';
export const outsideId = '@outside';
export const rules = Object.freeze({
  version: 1, sample: 120, minGap: 15, proportionalGap: .05, crowding: .25, reserveMargin: .15,
  bankDays: 14, taskDays: 7, urgentDays: 2, examDays: 3, idleDays: 4, concentrated: 90,
  evidenceDays: 28, trend: .05, budgetTolerance: .10, restDays: 4, hardFeedback: 3, change: .02,
});
export const presets = [
  { id: 'academic-history', name: '中国近代史纲要' },
  { id: 'academic-intro', name: '计算机导论' },
  { id: 'academic-health', name: '大学生心理健康' },
];
export interface Course {
  subjectId: string;
  mode: typeof modes[number];
  status: typeof states[number];
  activation: 'auto' | 'on' | 'off';
  disabled: boolean;
  credits: number | null;
  finalShare: number | null;
  cost: number | null;
  goal: number | null;
  coverageGoal: number | null;
  from: string;
  through: string;
  strategy: string;
  focus: string;
  focus2: string;
  checklist: string[] | null;
}
export interface Route {
  id: string; from: string; through: string; stage: Stage; label: string; focus: string;
}
export interface Term {
  id: string; name: string; from: string; through: string; archived: boolean;
  examWeek: string; reserve: number; override: Stage | ''; manual: Vector | null;
  courses: Course[]; routes: Route[];
}
export interface Assessment {
  id: string; termId: string; subjectId: string; examId: string; title: string;
  kind: 'exam' | 'assignment' | 'online' | 'oral' | 'diagnostic' | 'preparation';
  certainty: 'confirmed' | 'tentative' | 'unknown'; status: Exam['status'];
  day: string; time: string; prepare: string; required: boolean;
}
export interface Result {
  id: string; termId: string; subjectId: string; sessionId: string;
  day: string; at: number; activity: string; metric: typeof metrics[number];
  value: number | null; total: number | null; prompted: number | null;
  scope: string; difficulty: string; condition: typeof conditions[number];
  attempt: typeof attempts[number]; tags: string[]; note: string;
}
export interface Material {
  id: string; termId: string; subjectId: string; title: string; location: string;
  use: typeof materialStates[number]; note: string;
}
export interface Inputs {
  terms: Term[]; assessments: Assessment[]; exams: Exam[]; settings: Settings; school: string[]; archived: string[];
}
export interface ConfigVersion { at: number; inputs: Inputs }
export interface EvidenceResult {
  id: string; subjectId: string; day: string; at: number; activity: string; metric: Result['metric'];
  value: number | null; total: number | null; scope: string; difficulty: string;
  condition: Result['condition']; attempt: Result['attempt'];
}
export interface Evidence {
  subjectId: string; pair: [EvidenceResult, EvidenceResult]; count: number; goal: number;
  minutes: number; planned: number | null; investment: 'low' | 'enough' | 'unknown';
  direction: 'increase' | 'decrease'; gaps: [number, number] | null;
}
export interface Proposal {
  termId: string; week: string; effectiveAt: number; asOf: number; inputWeek: string;
  rule: number; baseline: string; fingerprint: string; before: Vector; after: Vector; evidence: Evidence;
  config: Inputs; inputConfig: ConfigVersion[]; budget: number | null;
}
export interface Adjustment {
  proposal: Proposal; confirmedAt: number; state: 'pending' | 'applied' | 'invalid' | 'paused' | 'rejected';
  appliedAt: number | null; endedAt: number | null; reason: string;
}
export interface Academic {
  currentTerm: string; otherId: string; aliases: { subjectId: string; name: string }[];
  terms: Term[]; assessments: Assessment[]; results: Result[]; materials: Material[];
  versions: ConfigVersion[]; adjustments: Adjustment[];
  next: { termId: string; day: string; subjectId: string; action: string; defer: boolean } | null;
}
export type DeskData = StudyData & { academic: Academic };

export function migrateStudy(study: StudyData): DeskData {
  const data = structuredClone(study);
  const school = data.subjects.filter(subject => subject.track === 'school');
  const aliases: Academic['aliases'] = [];
  const oldC = school.filter(subject => ['程序设计', 'C 语言', 'C语言'].includes(subject.name.trim()));
  if (oldC.length === 1 && oldC[0].id === 'school-2' && oldC[0].name === '程序设计') {
    aliases.push({ subjectId: oldC[0].id, name: oldC[0].name });
    oldC[0].name = 'C 语言';
  }
  function register(key: string, label: string) {
    const matching = school.filter(subject => subject.name === label);
    if (matching.length === 1 && !matching[0].archived) return matching[0].id;
    let id = key;
    for (let suffix = 2; data.subjects.some(subject => subject.id === id); suffix++) id = key + '-' + suffix;
    data.subjects.push({ id, name: label, track: 'school', archived: false });
    return id;
  }
  const otherId = register('academic-other', '其他课程');
  for (const preset of presets) register(preset.id, preset.name);
  return { ...data, academic: {
    currentTerm: '', otherId, aliases, terms: [], assessments: [], results: [], materials: [], versions: [],
    adjustments: [], next: null,
  } };
}

export function inputsOf(data: DeskData): Inputs {
  const school = data.subjects.filter(subject => subject.track === 'school');
  const ids = new Set(school.map(subject => subject.id));
  return {
    terms: data.academic.terms, assessments: data.academic.assessments,
    exams: data.exams.filter(exam => ids.has(exam.subjectId) || exam.importance === 'important'),
    settings: data.settings, school: [...ids].sort(), archived: school.filter(subject => subject.archived).map(subject => subject.id).sort(),
  };
}
export const inTerm = (day: string, term: Term) => day >= term.from && day <= term.through;
export const currentTerm = (data: DeskData) => data.academic.terms.find(term => term.id === data.academic.currentTerm);
export const blankCourse = (subjectId: string): Course => ({
  subjectId, mode: 'ability', status: 'unassessed', activation: 'auto', disabled: false,
  credits: null, finalShare: null, cost: null, goal: null, coverageGoal: null, from: '', through: '',
  strategy: '', focus: '', focus2: '', checklist: null,
});
