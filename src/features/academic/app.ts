import { channelName, exportBackup, importBackup, openStudyRepository, requireCurrent, same, type StudyRepository } from '../study/storage.ts';
import { localClock, monday, validDay } from '../study/time.ts';
import type { Exam } from '../study/model.ts';
import { baselineAt, scheduleOf } from './allocation.ts';
import { blankCourse, currentTerm, inTerm, inputsOf, reserveId, type Assessment,
  type Course, type DeskData, type Material, type Result, type Route, type Stage, type Term, type Vector } from './model.ts';
import { recordDecision } from './review.ts';
import { vector } from './validation.ts';
import { courses, home, resultActivities, results, review, schedule, settings } from './views.ts';

const root = document.querySelector<HTMLElement>('#academic')!;
const content = root.querySelector<HTMLElement>('[data-academic-content]')!;
const status = root.querySelector<HTMLElement>('[data-academic-status]')!;
const views = ['home', 'courses', 'schedule', 'results', 'review', 'settings'] as const;
type View = typeof views[number];
let repository: StudyRepository | undefined;
let data: DeskData;
let view: View = 'home';
let inspect = '';
let reportWeek = '';
let closed = false;
let prefill = '';
let editing = '';
let preview: ReturnType<typeof review>['preview'];
let dirty = false;
let busy = false;
let pending = false;
let refreshedAt = 0;
let channel: BroadcastChannel | undefined;
const termOf = (state: DeskData) => inspect ? state.academic.terms.find(term => term.id === inspect) : currentTerm(state);
const uuid = () => crypto.randomUUID();
const clock = () => localClock(Date.now(), data.settings.timezone);

function notify(message: string, error = false) {
  status.textContent = message;
  status.toggleAttribute('data-error', error);
}
function report(error: unknown) {
  notify('操作未完成。' + (error instanceof Error ? error.message : '请重试。'), true);
}
function resultFields(form: HTMLFormElement) {
  const fields = form.elements;
  const metric = (fields.namedItem('metric') as HTMLSelectElement).value;
  form.querySelector<HTMLElement>('[data-metric-values]')!.hidden = metric === 'done';
  form.querySelector<HTMLElement>('[data-prompted]')!.hidden = metric !== 'independent';
  const value = fields.namedItem('value') as HTMLInputElement;
  const total = fields.namedItem('total') as HTMLInputElement;
  value.required = total.required = metric !== 'done';
  value.step = total.step = ['score', 'official'].includes(metric) ? 'any' : '1';
  value.parentElement!.firstChild!.textContent = metric === 'independent' ? '独立正确数' : metric === 'count' ? '正确数' : metric === 'coverage' ? '已覆盖数量' : '实得分';
  total.parentElement!.firstChild!.textContent = ['independent', 'count'].includes(metric) ? '总题数' : metric === 'coverage' ? '题库总量' : '满分';
}

function render(reset = false) {
  const keep = reset ? [] : [...content.querySelectorAll<HTMLDetailsElement>('details[data-keep][open]')].map(item => item.dataset.keep);
  const term = termOf(data);
  const now = Date.now();
  preview = undefined;
  if (view === 'settings') content.innerHTML = settings(data, term, now);
  else if (!term) {
    content.innerHTML = '<section class="study-card"><h2>开始使用</h2><p>在设置中创建或选定学期。Study 的历史已在当前浏览器共享。</p>' +
      '<button type="button" class="study-action primary" data-view="settings">前往设置</button></section>';
  } else {
    switch (view) {
      case 'home': content.innerHTML = home(data, term, now); break;
      case 'courses': content.innerHTML = courses(data, term, now); break;
      case 'schedule': content.innerHTML = schedule(data, term, now); break;
      case 'results': content.innerHTML = results(data, term, clock().day, prefill, editing); break;
      case 'review': {
        const report = review(data, term, reportWeek || monday(clock().day), now, closed);
        content.innerHTML = report.html;
        preview = report.preview;
        break;
      }
    }
  }
  content.setAttribute('aria-busy', 'false');
  root.querySelectorAll('nav [data-view]').forEach(item => {
    if ((item as HTMLElement).dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  content.querySelectorAll<HTMLDetailsElement>('details[data-keep]').forEach(item => {
    if (keep.includes(item.dataset.keep)) item.open = true;
  });
  const result = content.querySelector<HTMLFormElement>('form[data-form="result"]');
  if (result) resultFields(result);
  refreshedAt = now;
}
function go(target: View) {
  view = target;
  dirty = false;
  closed = false;
  render(true);
  content.focus({ preventScroll: true });
}
function allowDiscard() {
  return !dirty || confirm('此处有未保存的输入。放弃并继续？');
}

type Row<T> = { rows: T[]; original: T[]; identify: (row: T) => string };
function editRow<T>({ rows, original, identify }: Row<T>, id: string, value?: T) {
  const index = rows.findIndex(item => identify(item) === id);
  requireCurrent(rows[index], original.find(item => identify(item) === id));
  if (index < 0) {
    if (value !== undefined) rows.push(value);
  } else if (value === undefined) rows.splice(index, 1);
  else rows[index] = value;
}
const itemId = (item: { id: string }) => item.id;
const rows = <K extends 'assessments' | 'results' | 'materials'>(state: DeskData, key: K) =>
  ({ rows: state.academic[key], original: data.academic[key], identify: itemId });
function activeTerm(state: DeskData, expected: Term | undefined): Term {
  const actual = termOf(state);
  if (!actual || actual.id !== expected?.id) throw new Error('当前学期已变化，请刷新后重试。');
  return actual;
}

async function commit(change: (state: DeskData, now: number) => void, message = '已保存。') {
  const now = Date.now();
  data = await repository!.update(state => change(state, now), now);
  dirty = false;
  notify(message);
}
function download(state: DeskData) {
  const url = URL.createObjectURL(new Blob([exportBackup(state)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'hikari-desk-backup-' + clock().day + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function restore(file: File) {
  if (file.size > 32 * 1024 * 1024) throw new Error('备份超过 32 MiB，无法读取。');
  const backup = importBackup(await file.text());
  const before = await repository!.read();
  if (before.timer && !same(before.timer, backup.timer)) throw new Error('请先在 Study 结算当前计时，再恢复备份。');
  const dialog = document.createElement('dialog');
  dialog.className = 'study-card';
  dialog.setAttribute('aria-labelledby', 'academic-restore-title');
  dialog.innerHTML = '<h2 id="academic-restore-title">恢复本地备份</h2><p></p><div class="study-actions">' +
    '<button type="button" class="study-action" data-before>导出现状</button>' +
    '<button type="button" class="study-action danger" data-restore>确认覆盖并恢复</button>' +
    '<button type="button" class="study-action" data-cancel>取消</button></div><p role="alert"></p>';
  dialog.querySelector('p')!.textContent = '备份包含 ' + backup.sessions.length + ' 条记录、' + backup.exams.length +
    ' 场考试、' + backup.plans.length + ' 份周计划、' + backup.reviews.length + ' 份 Study 复盘、' +
    backup.academic.terms.length + ' 个学期和 ' + backup.academic.results.length + ' 项成果。' +
    (backup.timer ? '含未结算计时。' : '') + '恢复会覆盖当前浏览器的两模块数据。';
  dialog.querySelector('[data-before]')!.addEventListener('click', () => download(before));
  dialog.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-restore]')!.addEventListener('click', () => {
    void run(async () => {
      try {
        data = await repository!.restore(before, backup);
        inspect = '';
        reportWeek = '';
        dialog.close();
        go('home');
        notify('完整备份已恢复。');
      } catch (error) {
        dialog.querySelector('[role="alert"]')!.textContent = error instanceof Error ? error.message : '恢复失败，请重试。';
      }
    });
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  root.append(dialog);
  dialog.showModal();
}

async function save(form: HTMLFormElement) {
  const fields = new FormData(form);
  const id = form.dataset.id ?? '';
  const kind = form.dataset.form;
  const read = (key: string) => String(fields.get(key) ?? '').trim();
  const num = (key: string) => read(key) === '' ? null : Number(read(key));
  const ratio = (key: string) => num(key) === null ? null : num(key)! / 100;
  const current = termOf(data);
  if (kind === 'review-week') {
    if (!validDay(read('week')) || read('week') > clock().day) throw new Error('请选择今天或更早的一周。');
    reportWeek = monday(read('week'));
    closed = false;
    dirty = false;
    render();
    return;
  }
  await commit((state, now) => {
    const academic = state.academic;
    if (kind === 'term') {
      const existing = data.academic.terms.find(item => item.id === id);
      const term: Term = {
        ...(existing ?? { id: uuid(), archived: false, examWeek: '', reserve: .03, override: '', manual: null, courses: [], routes: [] }),
        name: read('name'), from: read('from'), through: read('through'),
      };
      editRow({ rows: academic.terms, original: data.academic.terms, identify: itemId }, term.id, term);
      if (!existing) academic.currentTerm = term.id;
      return;
    }
    if (kind === 'subject-add') {
      state.subjects.push({ id: uuid(), name: read('name'), track: 'school', archived: false });
      return;
    }
    const term = activeTerm(state, current);
    const termUpdate = () => requireCurrent(term, current);
    switch (kind) {
      case 'course': {
        const original = current?.courses.find(item => item.subjectId === id);
        const subject = state.subjects.find(item => item.id === id);
        requireCurrent(subject, data.subjects.find(item => item.id === id));
        if (!subject) throw new Error('科目已变更。');
        const old = original ?? blankCourse(id);
        const next: Course = {
          ...old, mode: read('mode') as Course['mode'], status: read('status') as Course['status'],
          activation: read('activation') as Course['activation'], disabled: fields.has('disabled'),
          credits: num('credits'), finalShare: ratio('finalShare'), cost: num('cost'), goal: ratio('goal'),
          coverageGoal: ratio('coverageGoal'), from: read('from'), through: read('through'), strategy: read('strategy'),
          focus: read('focus'), focus2: read('focus2'),
        };
        editRow({ rows: term.courses, original: current!.courses, identify: item => item.subjectId }, id, next);
        if (subject.name !== read('name')) academic.aliases.push({ subjectId: id, name: subject.name });
        subject.name = read('name');
        subject.archived = fields.has('archived');
        break;
      }
      case 'stage':
        termUpdate();
        if (read('examWeek') && (!validDay(read('examWeek')) || monday(read('examWeek')) !== read('examWeek'))) throw new Error('预计考试周请选择周一。');
        term.override = read('override') as Stage | '';
        term.examWeek = read('examWeek');
        break;
      case 'route': {
        const route: Route = { id: id || uuid(), from: read('from'), through: read('through'),
          stage: read('stage') as Stage, label: read('label'), focus: read('focus') };
        if (term.routes.some(item => item.id !== route.id && item.stage !== 'vacation' && route.stage !== 'vacation' &&
          item.from <= route.through && route.from <= item.through)) throw new Error('训练阶段的日期不能重叠。');
        editRow({ rows: term.routes, original: current!.routes, identify: itemId }, route.id, route);
        break;
      }
      case 'assessment': {
        const original = scheduleOf(inputsOf(data), current!).find(row => row.id === id);
        const latest = scheduleOf(inputsOf(state), term).find(row => row.id === id);
        requireCurrent(latest, original);
        const metadata = academic.assessments.find(item => item.id === id || item.examId && item.examId === id);
        const row: Assessment = {
          id: metadata?.id || id || uuid(), termId: term.id, subjectId: read('subjectId'), examId: '',
          title: read('title'), kind: read('kind') as Assessment['kind'], certainty: read('certainty') as Assessment['certainty'],
          status: read('status') as Assessment['status'], day: read('day'), time: read('time'), prepare: read('prepare'),
          required: fields.has('required'),
        };
        if (row.certainty === 'unknown') row.day = '';
        if (row.kind === 'exam' && row.certainty === 'confirmed') {
          row.examId = original?.examId || uuid();
          const previous = data.exams.find(exam => exam.id === row.examId);
          const exam: Exam = {
            id: row.examId, subjectId: row.subjectId, name: row.title, day: row.day,
            start: read('start'), end: read('end') || row.time, importance: read('importance') as Exam['importance'],
            mastery: previous?.mastery ?? 'new', status: row.status, note: previous?.note ?? '',
          };
          if (row.status === 'completed') exam.closedAt = previous?.closedAt ?? now;
          editRow({ rows: state.exams, original: data.exams, identify: itemId }, exam.id, exam);
        } else if (original?.examId) {
          editRow({ rows: state.exams, original: data.exams, identify: itemId }, original.examId);
        }
        editRow(rows(state, 'assessments'), row.id, row);
        break;
      }
      case 'result': {
        if (!validDay(read('day')) || !inTerm(read('day'), term) || read('day') > clock().day) throw new Error('成果日期必须在该学期内，且不晚于今天。');
        const metric = read('metric') as Result['metric'];
        const row: Result = {
          id: id || uuid(), termId: term.id, subjectId: read('subjectId'), sessionId: read('sessionId'),
          day: read('day'), at: now, activity: read('activity'), metric,
          value: metric === 'done' ? null : num('value'), total: metric === 'done' ? null : num('total'),
          prompted: metric === 'independent' ? num('prompted') : null,
          scope: read('scope'), difficulty: read('difficulty'), condition: read('condition') as Result['condition'],
          attempt: read('attempt') as Result['attempt'], tags: [...fields.keys()].filter(key => key.startsWith('tag-')).map(key => key.slice(4)), note: read('note'),
        };
        if (id) {
          const previous = data.academic.results.find(item => item.id === id);
          row.at = previous?.at ?? now;
        }
        if (row.metric !== 'done' && (row.value === null || !row.total || row.value + (row.prompted ?? 0) > row.total)) {
          throw new Error('请填写正数总量。独立正确和提示后正确的合计不能超过总量。');
        }
        editRow(rows(state, 'results'), row.id, row);
        break;
      }
      case 'material':
      case 'material-add': {
        const original = kind === 'material' ? data.academic.materials.find(item => item.id === id) : undefined;
        const row: Material = {
          id: original?.id ?? uuid(), termId: term.id, subjectId: original?.subjectId ?? id,
          title: read('title'), location: read('location'), use: read('use') as Material['use'], note: read('note'),
        };
        editRow(rows(state, 'materials'), row.id, row);
        break;
      }
      case 'reserve':
        termUpdate();
        if (ratio('reserve') === null) throw new Error('请填写机动比例。');
        if (term.reserve !== ratio('reserve')) term.manual = null;
        term.reserve = ratio('reserve')!;
        break;
      case 'manual': {
        termUpdate();
        const { weights } = baselineAt(inputsOf(state), term, localClock(now, state.settings.timezone), academic.otherId);
        const ids = Object.keys(weights).filter(key => key !== reserveId);
        const proposed: Vector = { ...Object.fromEntries(ids.map(key => [key, ratio(key)])), [reserveId]: term.reserve };
        if ([...fields.keys()].length !== ids.length || !vector(proposed)) throw new Error('请填写当前有效集的完整分配，含机动合计 100%。');
        term.manual = proposed;
        break;
      }
      case 'next':
        requireCurrent(academic.next, data.academic.next);
        academic.next = read('action') || fields.has('defer') ? { termId: term.id, day: clock().day,
          subjectId: read('subjectId'), action: read('action'), defer: fields.has('defer') } : null;
        break;
      case 'map-session': {
        const existing = data.sessions.find(item => item.id === read('sessionId'));
        const record = state.sessions.find(item => item.id === read('sessionId'));
        requireCurrent(record, existing);
        if (!record || record.subjectId !== academic.otherId || !inTerm(record.day, term)) throw new Error('请选择一条待归类课次。');
        if (!state.subjects.some(item => item.id === read('subjectId') && !item.archived && item.track === 'school')) throw new Error('请选择当前可用的校内科目。');
        record.subjectId = read('subjectId');
        break;
      }
    }
  });
  if (kind === 'term' && !id) {
    inspect = '';
    go('courses');
  } else if (kind === 'result') {
    prefill = read('subjectId');
    editing = '';
    render();
  } else render();
}

async function action(button: HTMLButtonElement) {
  const kind = button.dataset.action;
  const id = button.dataset.id ?? '';
  if (kind === 'retry') return initialize();
  if (button.dataset.view) {
    if (allowDiscard()) {
      if (button.dataset.view === 'home') inspect = '';
      go(button.dataset.view as View);
    }
    return;
  }
  if (kind === 'export') {
    download(await repository!.read());
    notify('备份已生成。');
    return;
  }
  if (!allowDiscard()) return;
  if (kind === 'import') return content.querySelector<HTMLInputElement>('[data-backup-file]')?.click();
  if (kind === 'result-course' || kind === 'edit-result') {
    prefill = kind === 'result-course' ? id : '';
    editing = kind === 'edit-result' ? id : '';
    go('results');
    return;
  }
  if (kind === 'inspect-term') {
    inspect = id;
    reportWeek = '';
    go('courses');
    return;
  }
  if (kind === 'close-week') {
    dirty = false;
    closed = true;
    render();
    return;
  }
  if (kind?.startsWith('delete') && !confirm('删除此项？')) return;
  if (kind === 'archive-term' && !confirm('归档该学期并保留历史？')) return;
  if (kind === 'delete-assessment' && data.exams.some(item => item.id === id) &&
      !confirm('这会删除 Study 中同一场共享考试。继续？')) return;
  const term = termOf(data);
  await commit((state, now) => {
    const academic = state.academic;
    if (kind === 'confirm' || kind === 'reject') {
      if (!preview) throw new Error('没有可确认的方案。');
      recordDecision(state, preview, now, kind === 'reject');
      return;
    }
    if (kind === 'current-term' || kind === 'archive-term' || kind === 'unarchive-term') {
      const row = academic.terms.find(item => item.id === id);
      requireCurrent(row, data.academic.terms.find(item => item.id === id));
      if (!row) throw new Error('学期已变化。');
      if (kind === 'current-term' && !row.archived) academic.currentTerm = id;
      else if (kind === 'unarchive-term') row.archived = false;
      else if (kind === 'archive-term') {
        row.archived = true;
        if (academic.currentTerm === id) academic.currentTerm = '';
      }
      return;
    }
    const latest = activeTerm(state, term);
    switch (kind) {
      case 'delete-route':
        editRow({ rows: latest.routes, original: term!.routes, identify: itemId }, id);
        break;
      case 'delete-assessment': {
        const row = academic.assessments.find(item => item.id === id || item.examId === id);
        if (row) editRow(rows(state, 'assessments'), row.id);
        if (data.exams.some(item => item.id === id)) editRow({ rows: state.exams, original: data.exams, identify: itemId }, id);
        break;
      }
      case 'delete-result':
        editRow(rows(state, 'results'), id);
        if (editing === id) editing = '';
        break;
      case 'delete-material':
        editRow(rows(state, 'materials'), id);
        break;
      case 'auto':
        requireCurrent(latest, term);
        latest.manual = null;
        break;
      case 'checklist': {
        requireCurrent(latest, term);
        const course = latest.courses.find(item => item.subjectId === id);
        if (!course) throw new Error('请先保存学期课程设置。');
        const required = scheduleOf(inputsOf(state), latest).filter(item => item.subjectId === id && item.required && item.status !== 'cancelled');
        if (!required.length) throw new Error('请先在日程中登记必需考核。');
        course.checklist = required.map(item => item.id).sort();
        break;
      }
    }
  }, kind === 'confirm' ? '调整已确认。生效状态可在周报查看。' : kind === 'reject' ? '已拒绝。当前比例保持原样。' : '已保存。');
  if (kind === 'current-term') inspect = '';
  render();
}

async function run(task: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  try { await task(); }
  catch (error) { report(error); }
  finally { busy = false; }
}
root.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view],button[data-action]');
  if (target && (repository || target.dataset.action === 'retry')) void run(() => action(target));
});
root.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (!form.dataset.form) return;
  event.preventDefault();
  if (!repository) return;
  const fields = new FormData(form);
  if (form.dataset.form === 'course') {
    const previous = data.subjects.find(item => item.id === form.dataset.id);
    const nextName = String(fields.get('name') ?? '').trim();
    if (previous && nextName !== previous.name) {
      const records = data.sessions.filter(item => item.subjectId === previous.id).length;
      const exams = data.exams.filter(item => item.subjectId === previous.id).length;
      const timer = data.timer?.subjectId === previous.id ? '、1 个活动计时' : '';
      if (!confirm(previous.name + ' → ' + nextName + '。保留同一科目 ID，' + records + ' 条历史课次、' +
        exams + ' 场考试' + timer + '将显示新名称。确认更名？')) return;
    }
  }
  if (form.dataset.form === 'map-session') {
    const record = data.sessions.find(item => item.id === fields.get('sessionId'));
    const subject = data.subjects.find(item => item.id === fields.get('subjectId'));
    if (record && subject && !confirm(record.day + ' · ' + record.minutes + ' 分钟：' +
      (data.subjects.find(item => item.id === record.subjectId)?.name ?? '') + ' → ' + subject.name + '。确认归类？')) return;
  }
  if (form.dataset.form === 'assessment' && (fields.get('kind') === 'exam' && fields.get('certainty') === 'confirmed' ||
      data.exams.some(item => item.id === form.dataset.id)) &&
      !confirm('保存会修改共享考试，也可能改变 Study 后续自动阶段和预算试算。继续？')) return;
  void run(() => save(form));
});
root.addEventListener('input', event => {
  if ((event.target as HTMLElement).closest('form')) dirty = true;
});
root.addEventListener('change', event => {
  const control = event.target as HTMLInputElement;
  if (control.matches('[data-backup-file]')) {
    const file = control.files?.[0];
    control.value = '';
    if (file) void run(() => restore(file));
  }
  if (control.matches('[data-recovery-file]')) {
    const file = control.files?.[0];
    control.value = '';
    if (file) void run(async () => {
      if (file.size > 32 * 1024 * 1024) throw new Error('备份超过 32 MiB，无法读取。');
      const backup = importBackup(await file.text());
      if (confirm('恢复这份已验证的备份？它含 ' + backup.sessions.length + ' 条学习记录和 ' +
        backup.academic.terms.length + ' 个学期。损坏的原快照将保留。')) await initialize(backup);
    });
    return;
  }
  const form = control.form;
  const term = repository && termOf(data);
  if (form?.dataset.form !== 'result' || !term) return;
  const fields = form.elements;
  const previousSubject = (fields.namedItem('subjectId') as HTMLSelectElement).value;
  if (control.name === 'sessionId' && control.value) {
    const record = data.sessions.find(item => item.id === control.value);
    if (record) {
      (fields.namedItem('day') as HTMLInputElement).value = record.day;
      (fields.namedItem('subjectId') as HTMLSelectElement).value = record.subjectId;
    }
  }
  if (['sessionId', 'subjectId'].includes(control.name)) {
    if (control.name === 'subjectId') (fields.namedItem('sessionId') as HTMLSelectElement).value = '';
    const id = (fields.namedItem('subjectId') as HTMLSelectElement).value;
    const suggestions = resultActivities(data, term, id);
    if (!editing && (control.name === 'subjectId' || id !== previousSubject)) {
      const recent = data.academic.results.findLast(row => row.termId === term.id && row.subjectId === id);
      (fields.namedItem('activity') as HTMLInputElement).value = recent?.activity ?? suggestions[0];
      const mode = term.courses.find(course => course.subjectId === id)?.mode;
      (fields.namedItem('metric') as HTMLSelectElement).value = recent?.metric ?? (mode === 'task' ? 'done' : 'score');
    }
    const datalist = form.querySelector<HTMLDataListElement>('datalist')!;
    datalist.replaceChildren(...suggestions.map(value => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    }));
  }
  if (control.name === 'activity' && control.value === '独立练习') (fields.namedItem('metric') as HTMLSelectElement).value = 'independent';
  resultFields(form);
});

async function refresh() {
  if (!repository || busy || dirty || root.querySelector('dialog[open]') || content.querySelector(':focus-visible')) {
    pending = true;
    return;
  }
  pending = false;
  await run(async () => {
    const latest = await repository!.read();
    if (dirty) { pending = true; return; }
    if (!same(data, latest) || Date.now() - refreshedAt >= 60_000) {
      data = latest;
      render();
    }
  });
}
async function initialize(recovery?: DeskData) {
  let opened: StudyRepository | undefined;
  try {
    repository?.close();
    opened = await openStudyRepository(recovery);
    data = await opened.read();
    repository = opened;
    notify(recovery ? '完整备份已恢复。损坏的本地快照已保留。' : '');
    render();
    if (!channel && typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel(channelName);
      channel.addEventListener('message', () => void refresh());
    }
  } catch (error) {
    opened?.close();
    repository = undefined;
    report(error);
    content.setAttribute('aria-busy', 'false');
    content.innerHTML = '<section class="study-card"><h2>本地数据暂不可用</h2><p>关闭其他 Study 或 Academic 窗口后再试。已有数据会保留。</p>' +
      '<div class="study-actions"><button type="button" class="study-action" data-action="retry">重试读取</button>' +
      '<label class="study-field">从经过验证的 JSON 恢复<input type="file" accept=".json,application/json" data-recovery-file></label></div></section>';
  }
}
window.addEventListener('focus', () => void refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden && (pending || Date.now() - refreshedAt >= 60_000)) void refresh(); }, 2000);
await initialize();
