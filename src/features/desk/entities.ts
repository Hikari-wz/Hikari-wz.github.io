import { migrateStudy, type DeskData } from '../academic/model.ts';
import { emptyData } from '../study/model.ts';
import { assertValid } from '../study/storage.ts';

export const kinds = ['settings', 'subjects', 'exams', 'plans', 'sessions', 'timer', 'reviews',
  'academic', 'terms', 'assessments', 'results', 'materials', 'versions', 'adjustments'] as const;
export type Kind = typeof kinds[number];
export interface Entity { kind: Kind; id: string; payload: unknown; ordinal: number; version: number; deleted: boolean; createdAt?: string; updatedAt?: string }
export interface Change { kind: Kind; id: string; payload: unknown; ordinal: number; expected: number | null; deleted: boolean }
export const keyOf = (row: Pick<Entity, 'kind' | 'id'>) => row.kind + '/' + row.id;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
export const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function flatten(data: DeskData): Entity[] {
  assertValid(data);
  if (Object.keys(data).some(key => !['settings','subjects','exams','plans','sessions','timer','reviews','academic'].includes(key))) {
    throw new Error('来源包含当前版本无法识别的业务字段，请保留原始备份并升级迁移工具。');
  }
  const rows: Entity[] = [];
  const put = (kind: Kind, id: string, payload: unknown) => rows.push({ kind, id, payload: structuredClone(payload), ordinal: rows.filter(row => row.kind === kind).length, version: 0, deleted: false });
  put('settings', 'current', data.settings);
  put('timer', 'current', data.timer);
  for (const kind of ['subjects', 'exams', 'sessions'] as const) for (const item of data[kind]) put(kind, item.id, item);
  for (const kind of ['plans', 'reviews'] as const) for (const item of data[kind]) put(kind, item.week, item);
  const { terms, assessments, results, materials, adjustments, versions, ...meta } = data.academic;
  put('academic', 'current', meta);
  put('versions', 'current', versions);
  for (const [kind, list] of Object.entries({ terms, assessments, results, materials })) {
    for (const item of list) put(kind as Kind, item.id, item);
  }
  for (const item of adjustments) put('adjustments', `${item.proposal.termId}_${item.proposal.week}_${item.confirmedAt}`, item);
  if (new Set(rows.map(keyOf)).size !== rows.length) throw new Error('记录标识冲突，请检查备份。');
  return rows;
}
export function materialize(rows: Entity[]): DeskData {
  if (!Array.isArray(rows) || rows.some(row => !row || !kinds.includes(row.kind) || typeof row.id !== 'string' ||
    !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || !Number.isSafeInteger(row.version) || row.version < 0 ||
    typeof row.deleted !== 'boolean') || new Set(rows.map(keyOf)).size !== rows.length) throw new Error('数据包含无法识别的类型、版本或重复标识。');
  if (!rows.length) return migrateStudy(emptyData());
  const live = rows.filter(row => !row.deleted);
  const single = (kind: Kind) => {
    const found = live.find(row => row.kind === kind && row.id === 'current');
    if (!found) throw new Error('云端快照不完整：' + kind + '。未将读取失败视为空数据库。');
    return structuredClone(found.payload);
  };
  const list = (kind: Kind) => live.filter(row => row.kind === kind).sort((a, b) => (a.ordinal - b.ordinal) || a.id.localeCompare(b.id)).map(row => structuredClone(row.payload));
  const data = { settings: single('settings'), timer: single('timer'), subjects: list('subjects'), exams: list('exams'),
    plans: list('plans'), sessions: list('sessions'), reviews: list('reviews'), academic: {
      ...single('academic') as object, terms: list('terms'), assessments: list('assessments'), results: list('results'),
      materials: list('materials'), versions: single('versions'), adjustments: list('adjustments'),
    } } as DeskData;
  assertValid(data);
  return data;
}
export function diff(rows: Entity[], next: DeskData): Change[] {
  const desired = new Map(flatten(next).map(row => [keyOf(row), row]));
  const previous = new Map(rows.map(row => [keyOf(row), row]));
  const changes: Change[] = [];
  for (const [key, row] of desired) {
    const old = previous.get(key);
    if (old?.deleted) throw new Error('该记录已在云端删除，禁止使用旧缓存恢复。请确认后使用新的记录标识。');
    if (!old || !equal(old.payload, row.payload)) changes.push({ ...row, ordinal: old?.ordinal ?? row.ordinal, expected: old?.version ?? null });
  }
  for (const [key, row] of previous) if (!row.deleted && !desired.has(key)) {
    changes.push({ kind: row.kind, id: row.id, payload: null, ordinal: row.ordinal, expected: row.version, deleted: true });
  }
  return changes;
}
export function apply(rows: Entity[], changes: Change[]): Entity[] {
  const result = new Map(rows.map(row => [keyOf(row), row]));
  for (const change of changes) result.set(keyOf(change), { kind: change.kind, id: change.id,
    payload: change.payload, ordinal: change.ordinal, version: (change.expected ?? 0) + 1, deleted: change.deleted });
  return [...result.values()];
}
