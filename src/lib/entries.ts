import { getCollection, type CollectionEntry } from 'astro:content';

export type Entry = CollectionEntry<'journal' | 'learn' | 'lab'>;
export function visibleEntries<C extends Entry['collection']>(collection: C) {
  return getCollection(collection, entry => import.meta.env.DEV || !entry.data.draft);
}

export function href(entry: Entry) {
  return '/' + entry.collection + '/' + entry.id + '/';
}
export function modified(entry: Entry) {
  return entry.data.updated ?? entry.data.date;
}
export function newestFirst(a: Entry, b: Entry) {
  return modified(b).getTime() - modified(a).getTime() || a.id.localeCompare(b.id);
}
export function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}
export const collectionLabels = { journal: '记录', learn: '学习', lab: '实验' } as const;
