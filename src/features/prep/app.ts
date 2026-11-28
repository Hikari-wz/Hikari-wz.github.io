import { cloudEnabled, client } from '../desk/client.ts';
import { openCloudRepository, pendingBackup, projected } from '../desk/repository.ts';
import { prepareDesk } from '../desk/ui.ts';
import { channelName } from '../study/storage.ts';
import { localClock, monday, shiftDay, validDay } from '../study/time.ts';
import { parsePrepMarkdown } from './import.ts';
import { createMaterials } from './materials.ts';
import {
  type DeskData,
  type PrepTask,
} from './model.ts';

type CloudRepository = Awaited<ReturnType<typeof openCloudRepository>>;
type Tab = 'routes' | 'materials';

interface PrepRoute {
  termId: string;
  courseId: string;
  week: string;
  tab: Tab;
}

interface ImportAnalysis {
  task: ReturnType<typeof parsePrepMarkdown>['tasks'][number];
  id: string;
  week: string;
  state: 'add' | 'select' | 'skip';
  reason: string;
  missingId: boolean;
}

const root = document.querySelector<HTMLElement>('#prep')!;
const content = root.querySelector<HTMLElement>('#prep-content')!;
const status = root.querySelector<HTMLElement>('#prep-status')!;
let materialHost = element('div', 'prep-material-host');
let materialScope = '';

let data: DeskData;
let repository: CloudRepository | undefined;
let route: PrepRoute;
let channel: BroadcastChannel | undefined;
let dialog: HTMLDialogElement | undefined;
let busy = false;
let blocked = false;
let refreshing = false;
let pendingRefresh = false;
let refreshedAt = 0;
let refreshGeneration = 0;
let sessionOwner = '';
const openWeeks = new Set<string>();

const currentMonday = () => monday(localClock(Date.now(), 'Asia/Shanghai').day);
const tasksOf = (state: DeskData) => state.prepTasks ?? [];
const materialsOf = (state: DeskData) => state.prepMaterials ?? [];
const taskId = (id: string) => (task: PrepTask) => task.id === id;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
}

function add(parent: Element, ...children: Array<Node | string | null | undefined | false>) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

function button(
  label: string,
  action: string,
  options: {
    id?: string;
    className?: string;
    focusKey?: string;
    disabled?: boolean;
    title?: string;
  } = {},
) {
  const node = element('button', options.className ?? 'study-action', label);
  node.type = 'button';
  node.dataset.action = action;
  if (options.id) node.dataset.id = options.id;
  if (options.focusKey) node.dataset.focusKey = options.focusKey;
  if (options.title) node.title = options.title;
  node.disabled = options.disabled ?? false;
  return node;
}

function link(label: string, href: string, className = 'study-action', focusKey = '') {
  const node = element('a', className, label);
  node.href = href;
  if (focusKey) node.dataset.focusKey = focusKey;
  return node;
}

function field(label: string, control: HTMLElement, hint = '') {
  const wrapper = element('label', 'study-field prep-field');
  add(wrapper, label, control);
  if (hint) add(wrapper, element('small', 'prep-field-hint', hint));
  return wrapper;
}

function textInput(name: string, value = '', required = false, maxLength = 200) {
  const input = element('input');
  input.type = 'text';
  input.name = name;
  input.value = value;
  input.required = required;
  input.maxLength = maxLength;
  input.autocomplete = 'off';
  return input;
}

function dateInput(name: string, value = '', required = false) {
  const input = element('input');
  input.type = 'date';
  input.name = name;
  input.value = value;
  input.required = required;
  input.min = '1900-01-01';
  input.max = '9998-12-31';
  return input;
}

function textArea(name: string, value = '', rows = 4, maxLength = 4000) {
  const input = element('textarea');
  input.name = name;
  input.value = value;
  input.rows = rows;
  input.maxLength = maxLength;
  return input;
}

function selectInput(name: string, options: Array<[string, string]>, value = '', required = false) {
  const select = element('select');
  select.name = name;
  select.required = required;
  for (const [optionValue, label] of options) {
    const option = element('option', '', label);
    option.value = optionValue;
    option.selected = optionValue === value;
    select.append(option);
  }
  return select;
}

function checkbox(name: string, label: string, checked = false) {
  const wrapper = element('label', 'study-check prep-check');
  const input = element('input');
  input.type = 'checkbox';
  input.name = name;
  input.checked = checked;
  add(wrapper, input, element('span', '', label));
  return { wrapper, input };
}

function notify(message: string, error = false) {
  status.textContent = message;
  status.toggleAttribute('data-error', error);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}

function report(error: unknown) {
  notify('操作未完成。' + errorMessage(error), true);
}

function formValue(form: HTMLFormElement, name: string) {
  return String(new FormData(form).get(name) ?? '');
}

function termOptions(state: DeskData) {
  return state.academic.terms.map<[string, string]>(term => [
    term.id,
    term.name + (term.archived ? '（归档）' : ''),
  ]);
}

function activeTerm(state: DeskData) {
  return state.academic.terms.find(term => term.id === route.termId) ??
    state.academic.terms.find(term => term.id === state.academic.currentTerm) ??
    state.academic.terms.find(term => !term.archived) ??
    state.academic.terms[0];
}

function courseIds(state: DeskData, termId: string) {
  const term = state.academic.terms.find(item => item.id === termId);
  const configured = term?.courses.map(course => course.subjectId) ?? [];
  const referenced = [
    ...tasksOf(state).filter(task => task.termId === termId).map(task => task.courseId),
    ...materialsOf(state).filter(item => item.termId === termId).map(item => item.courseId),
  ];
  const health = state.subjects
    .filter(item => item.track === 'school' &&
      (item.id === 'academic-health' || /心理健康/.test(item.name)))
    .map(item => item.id);
  const ids = [...new Set([...configured, ...referenced, ...health])];
  const order = new Map(configured.map((id, index) => [id, index]));
  return ids.sort((left, right) => {
    const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder ||
      courseLabel(state, left).localeCompare(courseLabel(state, right), 'zh-CN');
  });
}

function courseLabel(state: DeskData, id: string) {
  return state.subjects.find(subject => subject.id === id)?.name ?? id;
}

function tasksFor(state: DeskData, termId: string, courseId: string, week: string) {
  return tasksOf(state)
    .filter(task => task.termId === termId && task.courseId === courseId && task.week === week)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

function routeUrl(next: Partial<PrepRoute> = {}) {
  const value = { ...route, ...next };
  const params = new URLSearchParams();
  if (value.termId) params.set('term', value.termId);
  if (value.week) params.set('week', value.week);
  if (value.courseId) {
    params.set('course', value.courseId);
    if (value.tab !== 'routes') params.set('tab', value.tab);
  }
  const query = params.toString();
  return '/desk/academic/prep/' + (query ? '?' + query : '');
}

function parseRoute(state: DeskData): PrepRoute {
  const params = new URLSearchParams(location.search);
  const requestedTerm = params.get('term') ?? '';
  const termId = state.academic.terms.some(term => term.id === requestedTerm)
    ? requestedTerm
    : state.academic.currentTerm || state.academic.terms.find(term => !term.archived)?.id || state.academic.terms[0]?.id || '';
  const ids = courseIds(state, termId);
  const requestedCourse = params.get('course') ?? '';
  const courseId = ids.includes(requestedCourse) ? requestedCourse : '';
  const requestedWeek = params.get('week') ?? '';
  const week = validDay(requestedWeek) ? monday(requestedWeek) : currentMonday();
  const tab: Tab = params.get('tab') === 'materials' ? 'materials' : 'routes';
  return { termId, courseId, week, tab };
}

function navigate(next: Partial<PrepRoute>, replace = false) {
  route = { ...route, ...next };
  if (!route.courseId) route.tab = 'routes';
  const url = routeUrl();
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  focusedKey = '';
  render();
  content.focus({ preventScroll: true });
}

function weekLabel(week: string) {
  const end = shiftDay(week, 6);
  return week.slice(0, 4) + ' 年 ' + week.slice(5).replace('-', '/') +
    ' – ' + end.slice(5).replace('-', '/');
}

function taskCounts(state: DeskData, termId: string, courseId: string, week: string) {
  const tasks = tasksFor(state, termId, courseId, week);
  return { total: tasks.length, done: tasks.filter(task => task.done).length, tasks };
}

function weekNavigation() {
  const nav = element('div', 'prep-week-nav');
  nav.dataset.weekNav = '';
  const previous = button('上一周', 'week-previous', { focusKey: 'week-previous' });
  const current = button('当前周', 'week-current', { focusKey: 'week-current' });
  const next = button('下一周', 'week-next', { focusKey: 'week-next' });
  current.classList.toggle('primary', route.week === currentMonday());
  add(nav, previous, current, next);
  return nav;
}

function termControl(state: DeskData) {
  const select = selectInput('term', termOptions(state), route.termId, true);
  select.id = 'prep-term';
  select.dataset.focusKey = 'term';
  select.setAttribute('aria-label', '选择学期');
  return select;
}

function courseControl(state: DeskData) {
  const values: Array<[string, string]> = [
    ['', '选择课程'],
    ...courseIds(state, route.termId).map<[string, string]>(id => [id, courseLabel(state, id)]),
  ];
  const select = selectInput('course', values, route.courseId, true);
  select.id = 'prep-course';
  select.dataset.focusKey = 'course';
  select.setAttribute('aria-label', '选择课程');
  return select;
}

function taskActions(task: PrepTask, detail = false) {
  const actions = element('div', 'prep-task-actions');
  add(actions,
    button('编辑', 'task-edit', { id: task.id, focusKey: `task-edit-${task.id}` }),
    button('删除', 'task-delete', { id: task.id, className: 'study-action danger', focusKey: `task-delete-${task.id}` }),
  );
  if (detail) {
    add(actions,
      button('上移', 'task-up', { id: task.id, title: '在学习路线中上移', focusKey: `task-up-${task.id}` }),
      button('下移', 'task-down', { id: task.id, title: '在学习路线中下移', focusKey: `task-down-${task.id}` }),
    );
  }
  return actions;
}

function taskItem(task: PrepTask, detail = false) {
  const item = element('li', 'prep-task');
  item.dataset.taskId = task.id;
  item.classList.toggle('is-done', task.done);
  const top = element('div', 'prep-task-main');
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.checked = task.done;
  checkbox.dataset.action = 'task-toggle';
  checkbox.dataset.id = task.id;
  checkbox.dataset.focusKey = `task-toggle-${task.id}`;
  checkbox.setAttribute('aria-label', `${task.done ? '标记为未完成' : '标记为已完成'}：${task.title}`);
  const copy = element('div', 'prep-task-copy');
  add(copy, element('strong', '', task.title));
  if (task.notes) {
    const notes = element('details', 'prep-task-notes-wrap');
    notes.append(
      element('summary', '', '备注'),
      element('p', 'prep-task-notes', task.notes),
    );
    copy.append(notes);
  }
  add(top, checkbox, copy);
  item.append(top);
  item.append(taskActions(task, detail));
  return item;
}

function taskList(tasks: PrepTask[], detail = false) {
  const list = element('ol', 'prep-task-list');
  for (const task of tasks) list.append(taskItem(task, detail));
  if (!tasks.length) {
    const empty = element('li', 'prep-empty', '本周还没有任务。可以先添加一项最小行动。');
    list.append(empty);
  }
  return list;
}

function homeCourseCard(state: DeskData, courseId: string) {
  const course = courseLabel(state, courseId);
  const counts = taskCounts(state, route.termId, courseId, route.week);
  const article = element('article', 'prep-course-card');
  const heading = element('div', 'prep-course-heading');
  add(heading,
    link(course, routeUrl({ courseId, tab: 'routes' }), 'prep-course-link', `course-${courseId}`),
    element('span', 'prep-course-count', counts.total ? `${counts.done}/${counts.total} 项完成` : '本周无任务'),
  );
  const actions = element('div', 'prep-course-actions');
  add(actions, button('添加任务', 'task-add', { id: courseId, focusKey: `add-${courseId}` }));
  article.append(heading, actions, taskList(counts.tasks, false));
  return article;
}

function emptyCourses(state: DeskData, ids: string[]) {
  const section = element('section', 'prep-empty-courses');
  add(section,
    element('h2', '', '本周暂无任务的课程'),
    element('p', 'study-muted', '空课程仍可直接打开，建立该课第一周路线或添加资料。'),
  );
  const list = element('div', 'prep-empty-links');
  for (const id of ids) {
    const item = link(courseLabel(state, id), routeUrl({ courseId: id }), 'prep-empty-link', `empty-${id}`);
    list.append(item);
  }
  if (!ids.length) add(list, element('span', 'study-muted', '所选学期没有空课程。'));
  section.append(list);
  return section;
}

function renderHome(state: DeskData) {
  const wrapper = element('div', 'prep-view prep-view-overview');
  wrapper.dataset.prepView = 'home';
  const toolbar = element('section', 'prep-toolbar study-card');
  const controls = element('div', 'prep-toolbar-controls');
  add(controls, field('学期', termControl(state)), weekNavigation());
  const actions = element('div', 'prep-toolbar-actions');
  add(actions, button('添加任务', 'task-add', { focusKey: 'task-add-global' }));
  add(toolbar, controls, actions);
  wrapper.append(toolbar);
  if (!state.academic.terms.length) {
    const empty = element('section', 'study-card prep-empty-state');
    add(empty,
      element('h2', '', '先创建学期与课程'),
      element('p', '', '课程备考复用学业中心中的学期、课程和历史记录。完成配置后回到此页。'),
      link('打开学业中心', '/desk/academic/', 'study-action primary'),
    );
    wrapper.append(empty);
    return wrapper;
  }
  const ids = courseIds(state, route.termId);
  const active = ids.filter(id => taskCounts(state, route.termId, id, route.week).total > 0);
  const empty = ids.filter(id => !active.includes(id));
  const courseSection = element('section', 'prep-course-section');
  const heading = element('div', 'prep-simple-heading');
  add(heading,
    element('div', '', ''),
    element('span', 'study-muted', weekLabel(route.week)),
  );
  heading.firstElementChild!.append(
    element('h2', '', activeTerm(state)?.name ?? '课程'),
    element('p', 'study-muted', '按课程查看本周任务；没有任务的课程仍可直接进入。'),
  );
  courseSection.append(heading);
  const grid = element('div', 'prep-course-grid');
  for (const id of active) grid.append(homeCourseCard(state, id));
  courseSection.append(grid);
  if (!active.length) {
    add(courseSection, element('p', 'prep-empty', '本周还没有课程任务。请选择上述课程添加，或导入现有 Markdown 备考计划。'));
  }
  wrapper.append(courseSection);
  if (empty.length) wrapper.append(emptyCourses(state, empty));
  return wrapper;
}

function detailHero(state: DeskData, courseId: string) {
  const course = courseLabel(state, courseId);
  const counts = taskCounts(state, route.termId, courseId, route.week);
  const hero = element('section', 'prep-detail-hero');
  const copy = element('div');
  add(copy,
    element('h2', '', course),
    element('p', 'prep-week-copy', `${weekLabel(route.week)} · ${counts.total ? `${counts.done}/${counts.total} 项完成` : '本周无任务'}`),
  );
  const actions = element('div', 'prep-detail-actions');
  add(actions, button('添加任务', 'task-add', { id: courseId, className: 'study-action primary', focusKey: 'task-add-detail' }));
  add(hero, copy, actions);
  return hero;
}

function detailTabs() {
  const nav = element('nav', 'prep-tabs');
  nav.setAttribute('aria-label', '课程备考视图');
  const routes = button('学习路线', 'tab-routes', { className: 'prep-tab', focusKey: 'tab-routes' });
  routes.dataset.prepTab = 'routes';
  routes.setAttribute('aria-current', route.tab === 'routes' ? 'page' : 'false');
  const materials = button('资料', 'tab-materials', { className: 'prep-tab', focusKey: 'tab-materials' });
  materials.dataset.prepTab = 'materials';
  materials.setAttribute('aria-current', route.tab === 'materials' ? 'page' : 'false');
  add(nav, routes, materials);
  return nav;
}

function renderRoutes(state: DeskData, courseId: string) {
  const section = element('section', 'study-card prep-routes-panel');
  const intro = element('div', 'prep-section-heading');
  add(intro,
    element('div', '', ''),
    button('添加任务', 'task-add', { id: courseId, className: 'study-action primary', focusKey: 'task-add-panel' }),
  );
  intro.firstElementChild!.append(
    element('h2', '', '学习路线'),
    element('p', 'study-muted', '当前周默认展开；其他任务周可单独展开查看。'),
  );
  section.append(intro);
  const weeks = [...new Set([
    route.week,
    ...tasksOf(state)
      .filter(task => task.termId === route.termId && task.courseId === courseId)
      .map(task => task.week),
  ])].sort();
  const weekList = element('div', 'prep-week-sections');
  for (const week of weeks) {
    const tasks = tasksFor(state, route.termId, courseId, week);
    const done = tasks.filter(task => task.done).length;
    const key = `${route.termId}/${courseId}/${week}`;
    const details = element('details', 'prep-week-section');
    details.dataset.prepWeek = week;
    details.open = week === route.week || openWeeks.has(key);
    const summary = element('summary');
    const summaryCopy = element('span');
    add(summaryCopy,
      element('strong', '', week === currentMonday() ? '当前周 · ' + weekLabel(week) : weekLabel(week)),
      element('small', '', tasks.length ? `${done}/${tasks.length} 项完成` : '暂无任务'),
    );
    const addHere = button('添加', 'task-add', {
      id: courseId,
      className: 'study-action prep-small-action',
      focusKey: `task-add-${week}`,
    });
    addHere.dataset.week = week;
    add(summary, summaryCopy, addHere);
    details.append(summary, taskList(tasks, true));
    weekList.append(details);
  }
  section.append(weekList);
  return section;
}

function renderDetail(state: DeskData, courseId: string) {
  const wrapper = element('div', 'prep-view prep-view-detail');
  wrapper.dataset.prepView = 'detail';
  const backRow = element('div', 'prep-detail-toolbar');
  add(backRow,
    link('返回课程概览', routeUrl({ courseId: '' }), 'study-action', 'back-home'),
    field('学期', termControl(state)),
    field('课程', courseControl(state)),
    weekNavigation(),
  );
  wrapper.append(backRow, detailHero(state, courseId), detailTabs());
  if (route.tab === 'materials') {
    const scope = JSON.stringify([route.termId, courseId]);
    if (scope !== materialScope) {
      for (const open of materialHost.querySelectorAll<HTMLDialogElement>('dialog[open]')) open.close();
      materialHost = element('div', 'prep-material-host');
      materialHost.dataset.materialHost = '';
      materialScope = scope;
    }
    wrapper.append(materialHost);
  } else {
    for (const open of materialHost.querySelectorAll<HTMLDialogElement>('dialog[open]')) open.close();
    wrapper.append(renderRoutes(state, courseId));
  }
  return wrapper;
}

let focusedKey = '';

function render() {
  if (!data || blocked) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest('[data-focus-key]')) {
    focusedKey = active.closest<HTMLElement>('[data-focus-key]')!.dataset.focusKey ?? '';
  }
  const term = activeTerm(data);
  if (term && term.id !== route.termId) route.termId = term.id;
  if (route.courseId && !courseIds(data, route.termId).includes(route.courseId)) {
    route.courseId = '';
    route.tab = 'routes';
  }
  content.replaceChildren(route.courseId ? renderDetail(data, route.courseId) : renderHome(data));
  content.dataset.prepView = route.courseId ? 'detail' : 'home';
  content.setAttribute('aria-busy', 'false');
  document.title = (route.courseId ? courseLabel(data, route.courseId) + ' · ' : '') + '课程学习与备考中心 · Hikari\'s Space';
  if (route.courseId && route.tab === 'materials') {
    const host = content.querySelector<HTMLElement>('[data-material-host]');
    if (host) {
      const { termId, courseId } = route;
      createMaterials(host, {
        termId,
        courseId,
        onError: report,
        read: () => materialsOf(data),
        update: async mutate => {
          if (!repository || blocked) throw new Error('当前页面已不能写入私人资料。');
          data = await repository.update(mutate);
          if (blocked) throw new Error('登录状态已改变，请重新打开页面。');
        },
      });
    }
  }
  if (focusedKey) {
    content.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
  }
  refreshedAt = Date.now();
}

async function commit(change: (state: DeskData) => void, message: string) {
  if (!repository || blocked) throw new Error('当前页面已不能写入私人数据，请重新打开。');
  busy = true;
  content.setAttribute('aria-busy', 'true');
  try {
    data = await repository.update(change);
    if (blocked) return;
    focusedKey = '';
    render();
    notify(message);
  } finally {
    busy = false;
    content.setAttribute('aria-busy', 'false');
  }
}

function nextPosition(tasks: PrepTask[], termId: string, courseId: string, week: string) {
  return Math.max(-1, ...tasks
    .filter(task => task.termId === termId && task.courseId === courseId && task.week === week)
    .map(task => task.position)) + 1;
}

function openDialog(title: string, description = '') {
  dialog?.close();
  const previous = document.activeElement;
  const modalElement = document.createElement('dialog');
  modalElement.className = 'study-card prep-dialog';
  modalElement.setAttribute('aria-labelledby', 'prep-dialog-title');
  const heading = document.createElement('div');
  heading.className = 'prep-dialog-heading';
  const headingText = document.createElement('h2');
  headingText.id = 'prep-dialog-title';
  headingText.textContent = title;
  const close = button('关闭', 'dialog-close');
  close.addEventListener('click', () => modalElement.close());
  add(heading, headingText, close);
  modalElement.append(heading);
  if (description) {
    const copy = element('p', 'study-muted', description);
    modalElement.append(copy);
  }
  modalElement.addEventListener('close', () => {
    modalElement.remove();
    if (dialog === modalElement) dialog = undefined;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    else content.focus();
  }, { once: true });
  root.append(modalElement);
  dialog = modalElement;
  modalElement.showModal();
  return modalElement;
}

function courseValues(state: DeskData) {
  const ids = courseIds(state, route.termId);
  return ids.map<[string, string]>(id => [id, courseLabel(state, id)]);
}

function openTaskDialog(
  task?: PrepTask,
  presetCourseId = route.courseId,
  presetWeek = route.week,
) {
  if (blocked) return;
  const values = courseValues(data);
  const modal = openDialog(task ? '编辑任务' : '添加备考任务');
  if (!values.length) {
    add(modal, element('p', 'prep-empty', '当前学期还没有可关联课程，请先在学业中心配置课程。'));
    return;
  }
  const form = element('form', 'study-form prep-task-form');
  form.dataset.form = task ? 'task-edit' : 'task-add';
  if (task) form.dataset.id = task.id;
  const course = selectInput('courseId', values, task?.courseId ?? presetCourseId ?? values[0][0], true);
  course.dataset.focusKey = 'task-course';
  const week = dateInput('week', task?.week ?? presetWeek, true);
  week.dataset.focusKey = 'task-week';
  const title = textInput('title', task?.title ?? '', true, 200);
  title.dataset.focusKey = 'task-title';
  const notes = textArea('notes', task?.notes ?? '', 5, 10_000);
  notes.dataset.focusKey = 'task-notes';
  const fields = element('div', 'study-fields');
  add(fields,
    field('课程', course),
    field('所属周（周一）', week, '周任务会显示在这一天的课程路线中。'),
  );
  const actions = element('div', 'study-actions');
  const submit = element('button', 'study-action primary', '保存');
  submit.type = 'submit';
  submit.dataset.focusKey = 'task-submit';
  add(actions, submit, button('取消', 'dialog-cancel'));
  actions.lastElementChild!.addEventListener('click', () => modal.close());
  add(form, fields, field('任务标题', title), field('备注', notes), actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const targetWeek = formValue(form, 'week');
    if (monday(targetWeek) !== targetWeek) {
      week.setCustomValidity('请选择周一作为任务所属周。');
      week.reportValidity();
      week.setCustomValidity('');
      return;
    }
    const courseId = formValue(form, 'courseId');
    const taskTitle = formValue(form, 'title').trim();
    const taskNotes = formValue(form, 'notes').trim();
    void runDialogAction(modal, async () => {
      if (!taskTitle) throw new Error('任务标题不能为空。');
      openWeeks.add(`${route.termId}/${courseId}/${targetWeek}`);
      await commit(state => {
        const list = state.prepTasks ??= [];
        if (task) {
          const current = list.find(taskId(task.id));
          if (!current) throw new Error('任务已在另一个窗口删除，请刷新后重试。');
          const moved = current.courseId !== courseId || current.week !== targetWeek;
          current.courseId = courseId;
          current.week = targetWeek;
          current.title = taskTitle;
          current.notes = taskNotes;
          if (moved) current.position = nextPosition(list, current.termId, courseId, targetWeek);
        } else {
          list.push({
            id: crypto.randomUUID(),
            courseId,
            termId: route.termId,
            week: targetWeek,
            title: taskTitle,
            notes: taskNotes,
            done: false,
            position: nextPosition(list, route.termId, courseId, targetWeek),
          });
        }
      }, task ? '任务已更新。' : '任务已添加。');
      modal.close();
    });
  });
  modal.append(form);
  title.focus();
}

async function runDialogAction(modal: HTMLDialogElement, action: () => Promise<void>) {
  const alert = modal.querySelector<HTMLElement>('[role="alert"]');
  if (alert) alert.textContent = '';
  const controls = [...modal.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea')];
  const previous = controls.map(item => item.disabled);
  controls.forEach(item => { item.disabled = true; });
  try {
    await action();
  } catch (error) {
    report(error);
    if (alert) alert.textContent = errorMessage(error);
    else {
      const message = element('p', 'study-status', errorMessage(error));
      message.setAttribute('role', 'alert');
      modal.querySelector('form')?.prepend(message);
    }
  } finally {
    controls.forEach((item, index) => { if (item.isConnected) item.disabled = previous[index]; });
  }
}

async function deleteTask(id: string) {
  const task = tasksOf(data).find(taskId(id));
  if (!task || busy) return;
  if (!confirm(`删除任务“${task.title}”？`)) return;
  await commit(state => {
    const list = state.prepTasks ?? [];
    const index = list.findIndex(taskId(id));
    if (index < 0) throw new Error('任务已在另一个窗口删除。');
    list.splice(index, 1);
    const remaining = list
      .filter(item => item.termId === task.termId && item.courseId === task.courseId && item.week === task.week)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    remaining.forEach((item, position) => { item.position = position; });
  }, '任务已删除。');
}

async function toggleTask(id: string, done: boolean) {
  await commit(state => {
    const current = (state.prepTasks ?? []).find(taskId(id));
    if (!current) throw new Error('任务已在另一个窗口变更，请刷新后重试。');
    current.done = done;
  }, done ? '任务已完成。' : '任务已标记为未完成。');
}

async function moveTask(id: string, direction: -1 | 1) {
  await commit(state => {
    const current = (state.prepTasks ?? []).find(taskId(id));
    if (!current) throw new Error('任务已在另一个窗口变更。');
    const list = (state.prepTasks ?? [])
      .filter(item => item.termId === current.termId && item.courseId === current.courseId && item.week === current.week)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    list.forEach((item, position) => { item.position = position; });
    const index = list.findIndex(item => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    [list[index].position, list[target].position] = [list[target].position, list[index].position];
  }, '任务顺序已更新。');
}

function normalizedTitle(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

async function importHash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function deletedPrepIds() {
  const cache = await pendingBackup();
  return new Set(projected(cache)
    .filter(row => row.kind === 'prepTasks' && row.deleted)
    .map(row => row.id));
}

async function analyzeImport(
  result: ReturnType<typeof parsePrepMarkdown>,
  termId: string,
  courseId: string,
  weekOne: string,
  deleted: Set<string>,
) {
  const tasks = tasksOf(data);
  const existing = tasks.filter(task => task.termId === termId && task.courseId === courseId);
  const prefix = 'prep-task-' + (await importHash([termId, courseId].join('\0'))).slice(0, 24) + '-';
  const hasHistory = existing.length > 0 || tasks.some(task => task.id.startsWith(prefix)) ||
    [...deleted].some(id => id.startsWith(prefix));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const fingerprint = new Map(existing.map(task => [
    task.week + '\u0000' + normalizedTitle(task.title),
    task,
  ]));
  const rows: ImportAnalysis[] = [];
  const seenIds = new Set<string>();
  const seenGeneratedTitles = new Set<string>();
  for (const task of result.tasks) {
    const id = prefix + (await importHash(task.sourceKey)).slice(0, 32);
    const week = task.week <= 10_000 ? shiftDay(weekOne, (task.week - 1) * 7) : '';
    const missingId = task.generated;
    const sameId = byId.get(id);
    const scope = week + '\u0000' + normalizedTitle(task.title);
    const sameTitle = fingerprint.get(scope);
    let state: ImportAnalysis['state'] = missingId && hasHistory ? 'select' : 'add';
    let reason = missingId
      ? hasHistory
        ? '来源缺少稳定 ID；该课程已有记录，勾选后才导入。'
        : '来源缺少稳定 ID；确认后将随本次文件批量添加。'
      : '';
    if (!validDay(week) || task.title.length > 200 || task.notes.length > 10_000 || task.sourceKey.length > 500) {
      state = 'skip';
      reason = '周次或字段长度超出支持范围，已跳过。';
    } else if (seenIds.has(id)) {
      state = 'skip';
      reason = '文件内标识重复，已跳过。';
    } else if (deleted.has(id)) {
      state = 'skip';
      reason = '该来源标识已删除，防止恢复旧记录，已跳过。';
    } else if (sameId) {
      state = 'skip';
      reason = '已存在，保留当前内容和完成状态。';
    } else if (missingId && sameTitle) {
      state = 'skip';
      reason = '同一周已有同名任务，标题指纹相同，已跳过。';
    } else if (missingId && seenGeneratedTitles.has(scope)) {
      state = 'skip';
      reason = '文件内同一周有同名任务，已跳过重复项。';
    }
    if (missingId && state !== 'skip') seenGeneratedTitles.add(scope);
    seenIds.add(id);
    rows.push({ task, id, week, state, reason, missingId });
  }
  return rows;
}

function importTaskNote(taskNotes: string, globalNotes: string) {
  const notes = globalNotes.trim();
  if (!notes || taskNotes.includes(notes)) return taskNotes;
  return [taskNotes.trim(), '课程全局说明\n' + notes].filter(Boolean).join('\n\n').slice(0, 10_000);
}

async function openImportPreview(
  text: string,
  sourceFile: File,
  initialCourseId = route.courseId,
) {
  const result = parsePrepMarkdown(text);
  const values = courseValues(data);
  if (!values.length) throw new Error('当前学期没有可导入的课程。');
  const courseName = (value: string) => normalizedTitle(value).replace('中国近现代史纲要', '中国近代史纲要');
  const sourceName = courseName(result.course);
  const matches = values.filter(([id, label]) =>
    courseName(label) === sourceName || data.academic.aliases.some(alias =>
      alias.subjectId === id && courseName(alias.name) === sourceName));
  const destinationId = matches.length === 1 ? matches[0][0] : initialCourseId;
  let weekOne = currentMonday();
  const modal = openDialog('确认 Markdown 导入', '先核对来源、目标课程、W1 周一日期、警告和去重结果。');
  const form = element('form', 'study-form prep-import-preview');
  form.dataset.form = 'import-confirm';
  const source = element('section', 'prep-import-source');
  add(source,
    element('h3', '', '来源'),
    element('p', '', '识别课程：' + (result.course || '未识别')),
    element('p', 'study-muted', `文件：${sourceFile.name} · 解析到 ${result.tasks.length} 项任务，${result.warnings.length} 条警告。`),
  );
  if (result.warnings.length) {
    const warningList = element('ul', 'prep-import-warnings');
    for (const warning of result.warnings) warningList.append(element('li', '', warning));
    source.append(warningList);
  }
  form.append(source);
  const destination = selectInput('destinationCourse', [['', '选择目标课程'], ...values], destinationId, true);
  destination.dataset.importDestination = '';
  destination.dataset.focusKey = 'import-destination';
  const mondayInput = dateInput('weekOne', weekOne, true);
  mondayInput.dataset.importWeekOne = '';
  mondayInput.dataset.focusKey = 'import-week-one';
  const settings = element('div', 'study-fields');
  add(settings,
    field('目标课程', destination, '系统建议仅作提示，必须由你确认。'),
    field('W1 的周一', mondayInput, '解析到的“第 1 周”会从这里开始。'),
  );
  form.append(settings);
  const destinationSummary = element('p', 'study-callout');
  form.append(destinationSummary);
  const resultHost = element('div', 'prep-import-result');
  form.append(resultHost);
  const notes = element('details', 'prep-import-notes');
  const notesSummary = element('summary', '', `课程级说明${result.notes ? `（${result.notes.length} 字）` : '（无）'}`);
  notes.append(notesSummary);
  add(notes, element('p', 'study-muted', result.notes
    ? '这些说明不属于单条任务；导入后会作为独立小节附到第一条新增任务。'
    : '没有可供附加的课程级说明。'));
  if (result.notes) notes.append(element('pre', 'prep-import-notes__text', result.notes));
  form.append(notes);
  let warningApprove: HTMLInputElement | undefined;
  if (result.warnings.length) {
    const warning = checkbox('warningApproved', '我已逐项核对上述文件警告与跳过项', false);
    warningApprove = warning.input;
    form.append(warning.wrapper);
  }
  const actions = element('div', 'study-actions');
  const confirm = element('button', 'study-action primary', '确认导入');
  confirm.type = 'submit';
  confirm.dataset.importApprove = '';
  confirm.dataset.focusKey = 'import-confirm';
  add(actions, confirm, button('取消', 'dialog-cancel'));
  actions.lastElementChild!.addEventListener('click', () => modal.close());
  form.append(actions);
  modal.append(form);

  let analysis: ImportAnalysis[] = [];
  let analysisGeneration = 0;
  const recompute = async () => {
    const generation = ++analysisGeneration;
    confirm.disabled = true;
    analysis = [];
    weekOne = mondayInput.value;
    destinationSummary.textContent = destination.value
      ? `准备导入到“${courseLabel(data, destination.value)}”，W1 从 ${weekOne || '未填写'} 开始。点击“确认导入”后才会写入。`
      : '请选择明确的导入目标课程。';
    if (!validDay(weekOne) || monday(weekOne) !== weekOne) {
      resultHost.replaceChildren(element('p', 'study-status', 'W1 日期必须是周一。'));
      confirm.disabled = true;
      return;
    }
    resultHost.replaceChildren(element('p', 'study-status', '正在核对已有任务与删除记录…'));
    try {
      const deleted = await deletedPrepIds();
      if (generation !== analysisGeneration || !form.isConnected) return;
      analysis = destination.value
        ? await analyzeImport(result, route.termId, destination.value, weekOne, deleted)
        : [];
      if (generation !== analysisGeneration || !form.isConnected) return;
      resultHost.replaceChildren(importAnalysisView(analysis, result));
      confirm.disabled = !analysis.some(row => row.state !== 'skip');
    } catch (error) {
      resultHost.replaceChildren(element('p', 'study-status', '无法检查已有记录，导入已暂停：' + errorMessage(error)));
      confirm.disabled = true;
    }
  };
  destination.addEventListener('change', () => {
    void recompute();
  });
  mondayInput.addEventListener('change', () => {
    void recompute();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (confirm.disabled) return;
    if (warningApprove && !warningApprove.checked) {
      report(new Error('请先核对该 Markdown 文件的警告。'));
      return;
    }
    const selectedRows = analysis.filter((row) => {
      if (row.state === 'add') return true;
      if (row.state !== 'select') return false;
      const input = resultHost.querySelector<HTMLInputElement>(`[data-import-item="${row.id}"]`);
      return input?.checked ?? false;
    });
    if (!selectedRows.length) {
      report(new Error('请至少选择一项要导入的任务。'));
      return;
    }
    const targetTermId = route.termId;
    const targetCourseId = destination.value;
    void runDialogAction(modal, async () => {
      const currentDeleted = await deletedPrepIds();
      const blockedRows = selectedRows.filter(row => currentDeleted.has(row.id));
      if (blockedRows.length) throw new Error('有来源标识已在其他窗口删除，导入已暂停，请重新预览。');
      let added = 0;
      let skipped = 0;
      let notesAttached = false;
      if (!repository || blocked) throw new Error('当前页面已不能写入私人任务。');
      data = await repository.update(state => {
        const list = state.prepTasks ??= [];
        for (const row of selectedRows) {
          if (list.some(task => task.id === row.id)) {
            skipped += 1;
            continue;
          }
          if (row.missingId && list.some(task => task.termId === targetTermId &&
            task.courseId === targetCourseId && task.week === row.week &&
            normalizedTitle(task.title) === normalizedTitle(row.task.title))) {
            skipped += 1;
            continue;
          }
          const taskNotes = !notesAttached ? importTaskNote(row.task.notes, result.notes) : row.task.notes;
          list.push({
            id: row.id,
            termId: targetTermId,
            courseId: targetCourseId,
            week: row.week,
            title: row.task.title,
            notes: taskNotes,
            done: row.task.done,
            position: nextPosition(list, targetTermId, targetCourseId, row.week),
            sourceKey: row.task.sourceKey,
          });
          notesAttached = true;
          added += 1;
        }
      });
      modal.close();
      render();
      notify(`已导入 ${added} 项任务${skipped ? `，并发更新后跳过 ${skipped} 项` : ''}。`);
    });
  });
  await recompute();
  if (analysis.length && !result.warnings.length && analysis.every(row => row.state === 'skip')) {
    modal.close();
    const reasons = new Set(analysis.map(row => row.reason.split(' ')[0]));
    notify(`这些任务均已在计划中，已跳过 ${analysis.length} 项${reasons.size ? '（' + [...reasons].join('；') + '）' : ''}。`);
  } else {
    destination.focus();
  }

}

function importAnalysisView(analysis: ImportAnalysis[], result: ReturnType<typeof parsePrepMarkdown>) {
  const wrapper = element('section', 'prep-import-analysis');
  const added = analysis.filter(row => row.state === 'add').length;
  const selectable = analysis.filter(row => row.state === 'select').length;
  const skipped = analysis.filter(row => row.state === 'skip').length;
  const summary = element('div', 'prep-import-counts');
  for (const [label, value] of [
    ['可导入', added],
    ['待选择', selectable],
    ['将跳过', skipped],
    ['文件警告', result.warnings.length],
  ] as const) {
    const item = element('div');
    add(item, element('strong', '', String(value)), element('span', '', label));
    summary.append(item);
  }
  add(wrapper, element('h3', '', '导入预览'), summary);
  const list = element('ol', 'prep-import-list');
  for (const row of analysis) {
    const item = element('li', 'prep-import-row');
    item.dataset.importState = row.state;
    if (row.state === 'select') {
      const pick = element('input');
      pick.type = 'checkbox';
      pick.dataset.importItem = row.id;
      pick.setAttribute('aria-label', `选择无编号任务：${row.task.title}`);
      item.append(pick);
    }
    const copy = element('div');
    add(copy,
      element('strong', '', `W${row.task.week} · ${row.task.title}`),
      element('small', '', row.week),
    );
    if (row.task.notes) copy.append(element('p', 'study-muted', row.task.notes));
    if (row.reason) {
      const reason = element('p', row.state === 'skip' ? 'study-muted' : 'study-callout caution', row.reason);
      copy.append(reason);
    }
    item.append(copy);
    list.append(item);
  }
  wrapper.append(list);
  return wrapper;
}

async function processMarkdownSource(text: string, file: File) {
  if (!text.trim()) throw new Error('Markdown 内容为空。');
  await openImportPreview(text, file, route.courseId);
}

function interactionIsSafe() {
  return !busy && !blocked && !dialog?.open &&
    !content.querySelector('dialog[open]') &&
    !content.querySelector('.prep-materials[aria-busy="true"]') &&
    !document.activeElement?.closest('form') &&
    !content.querySelector('form:focus-within');
}

async function refresh() {
  if (!repository || blocked) return;
  if (refreshing || !interactionIsSafe()) {
    pendingRefresh = true;
    return;
  }
  pendingRefresh = false;
  refreshing = true;
  const generation = ++refreshGeneration;
  const previous = data;
  try {
    const latest = await repository.read();
    if (blocked || busy || generation !== refreshGeneration || data !== previous || !interactionIsSafe()) {
      pendingRefresh = true;
      return;
    }
    if (JSON.stringify(latest) !== JSON.stringify(data)) {
      data = latest;
      render();
    }
    refreshedAt = Date.now();
  } catch (error) {
    if (!blocked && !busy) report(error);
  } finally {
    refreshing = false;
  }
}

function protectAuth() {
  if (blocked) return;
  blocked = true;
  pendingRefresh = false;
  refreshGeneration += 1;
  repository?.close();
  repository = undefined;
  channel?.close();
  channel = undefined;
  dialog?.close();
  dialog = undefined;
  root.inert = true;
  const importer = root.querySelector<HTMLButtonElement>('[data-action="import-open"]');
  if (importer) importer.disabled = true;
  content.setAttribute('aria-busy', 'false');
  const section = element('section', 'study-card prep-blocked');
  add(section,
    element('h2', '', '登录状态已改变'),
    element('p', '', '为避免向错误账号显示私人任务或资料，本页已停止读写。请刷新页面并重新登录。'),
  );
  const reload = button('重新登录', 'auth-reload', { className: 'study-action primary' });
  reload.addEventListener('click', () => location.reload());
  section.append(reload);
  content.replaceChildren(section);
  status.textContent = '已隐藏私人数据。';
  status.toggleAttribute('data-error', true);
}

root.addEventListener('toggle', event => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.dataset.prepWeek) return;
  const key = `${route.termId}/${route.courseId}/${details.dataset.prepWeek}`;
  if (details.open) openWeeks.add(key);
  else openWeeks.delete(key);
}, true);

root.addEventListener('change', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.matches('select[name="term"]')) {
    navigate({ termId: target.value, courseId: '', tab: 'routes' });
    return;
  }
  if (target.matches('select[name="course"]')) {
    navigate({ courseId: target.value, tab: 'routes' });
    return;
  }
  if (target.matches('[data-import-file]')) {
    const file = (target as HTMLInputElement).files?.[0];
    target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      report(new Error('Markdown 原稿超过 2 MiB，请精简后重试。'));
      return;
    }
    void (async () => {
      busy = true;
      content.setAttribute('aria-busy', 'true');
      try {
        await processMarkdownSource(await file.text(), file);
      } catch (error) {
        report(error);
      } finally {
        busy = false;
        content.setAttribute('aria-busy', 'false');
      }
    })();
    return;
  }
  if (target.matches('input[data-action="task-toggle"]')) {
    const checkbox = target as HTMLInputElement;
    void toggleTask(checkbox.dataset.id ?? '', checkbox.checked).catch(error => {
      report(error);
      render();
    });
  }
});

root.addEventListener('click', event => {
  const control = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!control || control.matches('input')) return;
  if (control.closest('summary')) event.preventDefault();
  const action = control.dataset.action;
  const id = control.dataset.id ?? '';
  if (action === 'week-previous' || action === 'week-next' || action === 'week-current') {
    const week = action === 'week-current'
      ? currentMonday()
      : shiftDay(route.week, action === 'week-previous' ? -7 : 7);
    navigate({ week: monday(week) });
  } else if (action === 'tab-routes' || action === 'tab-materials') {
    navigate({ tab: action === 'tab-materials' ? 'materials' : 'routes' });
  } else if (action === 'task-add') {
    const presetCourse = id || route.courseId;
    const presetWeek = control.dataset.week || route.week;
    openWeeks.add(`${route.termId}/${presetCourse}/${presetWeek}`);
    openTaskDialog(
      undefined,
      presetCourse,
      presetWeek,
    );
  } else if (action === 'task-edit') {
    const task = tasksOf(data).find(taskId(id));
    if (task) openTaskDialog(task);
    else report(new Error('任务已在另一个窗口删除。'));
  } else if (action === 'task-delete') {
    void deleteTask(id);
  } else if (action === 'task-up') {
    void moveTask(id, -1).catch(report);
  } else if (action === 'task-down') {
    void moveTask(id, 1).catch(report);
  } else if (action === 'import-open') {
    root.querySelector<HTMLInputElement>('#prep-import-file')?.click();
  }
});

window.addEventListener('popstate', () => {
  if (!data || blocked) return;
  route = parseRoute(data);
  openWeeks.clear();
  render();
});

function localMode() {
  const section = element('section', 'study-card prep-local-mode');
  add(section,
    element('h2', '', '课程学习与备考中心需要启用统一云端数据层'),
    element('p', '', '课程任务和私人文件只在登录后的云端模式中开放。当前本地构建不会创建另一套浏览器数据。'),
    element('p', 'study-muted', '请使用 PUBLIC_DESK_DATA_MODE=cloud 构建，并在数据中心登录后访问。'),
    link('打开数据中心', '/desk/data/', 'study-action primary'),
  );
  content.replaceChildren(section);
  content.dataset.prepView = 'home';
  content.setAttribute('aria-busy', 'false');
}

async function initialize() {
  try {
    await prepareDesk(root, content);
    if (!cloudEnabled) {
      localMode();
      return;
    }
    const auth = await client().auth.getSession();
    if (auth.error) throw auth.error;
    if (!auth.data.session) throw new Error('请先登录数据中心。');
    sessionOwner = auth.data.session.user.id;
    client().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (session && session.user.id !== sessionOwner) ||
        (event === 'INITIAL_SESSION' && !session)) protectAuth();
    });
    repository = await openCloudRepository();
    data = await repository.read();
    route = parseRoute(data);
    history.replaceState(null, '', routeUrl(route));
    render();
    const importer = root.querySelector<HTMLButtonElement>('[data-action="import-open"]');
    if (importer) importer.disabled = false;
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel(channelName);
      channel.addEventListener('message', () => {
        pendingRefresh = true;
      });
    }
    window.addEventListener('focus', () => {
      pendingRefresh = true;
      void refresh();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        pendingRefresh = true;
        void refresh();
      }
    });
    window.addEventListener('online', () => {
      pendingRefresh = true;
      void refresh();
    });
    window.addEventListener('pageshow', () => {
      pendingRefresh = true;
      void refresh();
    });
    setInterval(() => {
      if (!document.hidden && pendingRefresh && interactionIsSafe()) void refresh();
    }, 1_000);
    setInterval(() => {
      if (!document.hidden && Date.now() - refreshedAt >= 30_000) void refresh();
    }, 30_000);
  } catch (error) {
    report(error);
    content.setAttribute('aria-busy', 'false');
    const section = element('section', 'study-card prep-unavailable');
    add(section,
      element('h2', '', '暂时无法打开课程学习与备考中心'),
      element('p', '', cloudEnabled
        ? '请检查登录、网络和同步状态。私人任务不会被当作空数据覆盖。'
        : '当前构建未启用统一云端数据层。'),
      link('打开数据中心', '/desk/data/', 'study-action primary'),
    );
    content.replaceChildren(section);
  }
}

window.addEventListener('pagehide', () => {
  repository?.close();
  channel?.close();
});

await initialize();
