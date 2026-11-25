export const tracks = ['school', 'self', 'project'] as const;
export type Track = typeof tracks[number];
export const trackNames: Record<Track, string> = { school: '校内学业', self: '自主学习', project: '项目实践' };

export const phases = ['normal', 'prepare', 'review', 'sprint', 'vacation'] as const;
export type Phase = typeof phases[number];
export type Split = [number, number, number];
export const phaseNames: Record<Phase, string> = {
  normal: '常规学习期', prepare: '期末准备期', review: '集中复习期', sprint: '考前冲刺期', vacation: '寒暑假自主学习期',
};
export const phaseRules: Record<Phase, string> = {
  normal: '距重要考试至少 29 天，或无近期重要考试',
  prepare: '距重要考试 15–28 天',
  review: '距重要考试 4–14 天',
  sprint: '距重要考试 0–3 天，且考试尚未结束',
  vacation: '已开启假期，且无 28 天内的重要考试',
};
export const defaultRatios: Record<Phase, Split> = {
  normal: [35, 50, 15], prepare: [50, 35, 15], review: [65, 25, 10],
  sprint: [90, 10, 0], vacation: [10, 65, 25],
};
export const learningQuality = ['能够独立应用', '借助提示完成', '仍需继续学习'] as const;
export const projectQuality = ['完成功能或阶段目标', '调试、修复与改进', '设计、研究与探索'] as const;
export const qualityFor = (track: Track) => track === 'project' ? projectQuality : learningQuality;
export const importanceNames = { important: '重要', normal: '普通', low: '低' } as const;
export const masteryNames = { new: '未掌握', basic: '基本掌握', skilled: '较熟练' } as const;
export const examStatusNames = { scheduled: '待考', completed: '已完成', cancelled: '已取消' } as const;

export interface Settings {
  timezone: string;
  buffer: number;
  ratios: Record<Phase, Split>;
  override: Phase | 'auto';
  vacation: boolean;
  untimedExam: 'endOfDay' | 'midday' | 'startOfDay';
}
export const defaultSettings = (): Settings => ({
  timezone: 'Asia/Shanghai', buffer: 10, ratios: structuredClone(defaultRatios),
  override: 'auto', vacation: false, untimedExam: 'endOfDay',
});

export interface Subject { id: string; track: Track; name: string; archived: boolean }
export interface Exam {
  id: string;
  name: string;
  subjectId: string;
  day: string;
  start: string;
  end: string;
  importance: keyof typeof importanceNames;
  mastery: keyof typeof masteryNames;
  status: keyof typeof examStatusNames;
  closedAt?: number;
  note: string;
}
export interface DailyAllocation {
  day: string;
  parts: { phase: Phase; minutes: number }[];
}
export interface Budget {
  available: number;
  reserve: number;
  allocatable: number;
  targets: Split;
  days: DailyAllocation[];
}
export interface WeeklyPlan {
  week: string;
  minutes: number[];
  beforeExam: (number | null)[];
  budget: Budget;
  manual: Split | null;
  previousTargets: Split | null;
  revision: number;
  updatedAt: number;
  focus: string;
}
export interface Session {
  id: string;
  day: string;
  subjectId: string;
  minutes: number;
  quality: string;
  note: string;
}
export interface Timer {
  id: string;
  day: string;
  subjectId: string;
  startedAt: number;
  elapsedMs: number;
  runningSince: number | null;
}
export interface Review {
  week: string;
  balance: string;
  knowledge: string;
  results: string;
  issues: string;
  nextFocus: string;
}
export interface StudyData {
  settings: Settings;
  subjects: Subject[];
  exams: Exam[];
  plans: WeeklyPlan[];
  sessions: Session[];
  timer: Timer | null;
  reviews: Review[];
}
export const emptyData = (): StudyData => {
  const defaults: Record<Track, string[]> = {
    school: ['高等数学', '大学英语', '程序设计', '其他课程'],
    self: ['C++', '算法', 'Python', '英语', '其他'],
    project: ['Hikari’s Space', 'QQ 待办助手', '个人软件', '其他项目'],
  };
  const subjects = tracks.flatMap(track => defaults[track].map((name, index) => ({
    id: `${track}-${index}`, name, track, archived: false,
  })));
  return { settings: defaultSettings(), subjects, exams: [], plans: [], sessions: [], timer: null, reviews: [] };
};
