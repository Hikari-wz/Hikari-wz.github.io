import { monday, validDay } from '../study/time.ts';

export type { DeskData } from '../academic/model.ts';

export interface PrepTask {
  id: string;
  // Resolve course labels from subjects; a historical ID may no longer be in the term's current course list.
  courseId: string;
  termId: string;
  week: string;
  title: string;
  notes: string;
  done: boolean;
  position: number;
  sourceKey?: string;
}

export interface PrepMaterial {
  id: string;
  courseId: string;
  termId: string;
  name: string;
  kind: 'file' | 'link';
  url?: string;
  filename?: string;
  mime?: string;
  bytes?: number;
  removing?: boolean;
}

export interface PrepData {
  prepTasks?: PrepTask[];
  prepMaterials?: PrepMaterial[];
}

export interface PrepCatalog {
  subjects: readonly { id: string; track: string }[];
  terms: readonly { id: string; from: string; through: string }[];
}

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const label = (value: unknown, max: number): value is string => text(value, max) && !!value.trim();
const identifier = (value: unknown, max = 100): value is string => text(value, max) && /^[\w-]+$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const optionalLabel = (item: Row, field: string, max: number) =>
  !Object.hasOwn(item, field) || label(item[field], max);
const optionalBoolean = (item: Row, field: string) =>
  !Object.hasOwn(item, field) || typeof item[field] === 'boolean';

export const prepMaterialFileLimit = 25 * 1024 * 1024;

// File objects use the authenticated user's UUID as the first path segment and the material UUID as the last.
export function prepMaterialPath(ownerId: string, materialId: string) {
  if (!uuid(ownerId) || !uuid(materialId)) throw new Error('备考资料文件路径必须由两个 UUID 组成。');
  return ownerId.toLowerCase() + '/' + materialId.toLowerCase();
}

function fail(message: string): never {
  throw new Error(message);
}

export function validatePrepData(value: unknown, catalog: PrepCatalog): asserts value is PrepData {
  if (!object(value)) fail('备考数据必须是对象。');
  if (value.prepTasks !== undefined && !Array.isArray(value.prepTasks)) fail('备考任务列表格式无效。');
  if (value.prepMaterials !== undefined && !Array.isArray(value.prepMaterials)) fail('备考资料列表格式无效。');

  const subjects = new Map(catalog.subjects.map(subject => [subject.id, subject]));
  const terms = new Map(catalog.terms.map(term => [term.id, term]));
  const taskIds = new Set<string>();
  for (const item of (value.prepTasks as unknown[] | undefined) ?? []) {
    if (!object(item) || !identifier(item.id) || !identifier(item.courseId) || !identifier(item.termId) ||
        !label(item.title, 200) || !text(item.notes, 10_000) || typeof item.done !== 'boolean' ||
        !Number.isSafeInteger(item.position) || Number(item.position) < 0 ||
        !text(item.week, 10) || !validDay(item.week) || monday(item.week) !== item.week) {
      fail('备考任务缺少有效标识、周一日期、标题、完成状态或排序。');
    }
    if (taskIds.has(item.id)) fail('备考任务标识重复：' + item.id);
    taskIds.add(item.id);
    const subject = subjects.get(item.courseId);
    if (!subject || subject.track !== 'school') fail('备考任务必须引用存在的校内课程：' + item.courseId);
    if (!terms.has(item.termId)) fail('备考任务必须引用存在的学期：' + item.termId);
    if (Object.hasOwn(item, 'sourceKey') && !label(item.sourceKey, 500)) fail('备考任务来源标识格式无效：' + item.id);
  }

  const materialIds = new Set<string>();
  for (const item of (value.prepMaterials as unknown[] | undefined) ?? []) {
    if (!object(item) || !uuid(item.id) || !identifier(item.courseId) || !identifier(item.termId) ||
        !label(item.name, 200) || !['file', 'link'].includes(String(item.kind))) {
      fail('备考资料缺少有效 UUID、课程、学期、名称或类型。');
    }
    if (materialIds.has(item.id)) fail('备考资料标识重复：' + item.id);
    materialIds.add(item.id);
    const subject = subjects.get(item.courseId);
    if (!subject || subject.track !== 'school') fail('备考资料必须引用存在的校内课程：' + item.courseId);
    if (!terms.has(item.termId)) fail('备考资料必须引用存在的学期：' + item.termId);
    if (Object.hasOwn(item, 'owner') || Object.hasOwn(item, 'ownerId')) fail('备考资料不得持久化文件所有者。');
    if (!optionalLabel(item, 'filename', 255) || !optionalLabel(item, 'mime', 200) ||
        !optionalBoolean(item, 'removing')) fail('备考资料文件元数据格式无效：' + item.id);

    if (item.kind === 'file') {
      if (Object.hasOwn(item, 'url')) fail('文件资料不得持久化访问 URL：' + item.id);
      if (Object.hasOwn(item, 'bytes') &&
          (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0 || Number(item.bytes) > prepMaterialFileLimit)) {
        fail('文件资料大小必须是 25 MiB 以内的非负整数：' + item.id);
      }
    } else {
      if (!text(item.url, 4096)) fail('链接资料必须包含 URL：' + item.id);
      let protocol = '';
      try { protocol = new URL(item.url).protocol; } catch { /* The message below is more useful than URL internals. */ }
      if (protocol !== 'http:' && protocol !== 'https:') fail('链接资料只支持 HTTP 或 HTTPS URL：' + item.id);
      if (Object.hasOwn(item, 'bytes') &&
          (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0)) fail('链接资料大小字段格式无效：' + item.id);
    }
  }
}
