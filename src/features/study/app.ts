import type { DeskData } from '../academic/model.ts';
import {
  defaultSettings, phaseNames, phases, tracks, type Exam, type Review, type Session, type Settings, type Split, type StudyData, type Track,
} from './model.ts';
import { calculateBudget, timerMs } from './planning.ts';
import {
  channelName, exportBackupBlob, importBackupFile, LegacyStudyUpgradeError, openStudyRepository,
  readLegacyStudy, requireCurrent, type StudyRepository,
} from './storage.ts';
import { targetsOf } from './statistics.ts';
import { localClock, monday, shiftDay, validDay, validTimezone } from './time.ts';
import {
  allocationText, budgetPreview, history, overview, planView, qualityOptions, recordsView, reviewView, sessionForm,
  settingsView, stageText, subjectOptions, timerText, type RecordFilters,
} from './views.ts';
import { setupOffline } from './offline.ts';

const container = document.querySelector<HTMLElement>('#study')!;
const content = container.querySelector<HTMLElement>('#study-content')!;
const status = container.querySelector<HTMLElement>('#study-status')!;
const policy = container.querySelector<HTMLTemplateElement>('#study-policy')!;
const views = ['overview', 'plan', 'records', 'policy', 'settings', 'review'] as const;
type View = typeof views[number];
let active: View = 'overview';
let data: DeskData;
let repository: StudyRepository;
let legacySnapshot: StudyData | undefined;
let week = '';
let reviewWeek = '';
let examId = '';
let sessionId = '';
let draft: { week: string; minutes?: number[]; focus?: string } | undefined;
let filters: RecordFilters = { track: '', subject: '', week: '', page: 0 };
let renderedMinute = '';
let busy = false;
let dialog: HTMLDialogElement | undefined;
let pendingRefresh = false;
let channel: BroadcastChannel | undefined;
const now = () => localClock(Date.now(), data.settings.timezone);
const currentWeek = () => monday(now().day);
const read = (fields: FormData, key: string) => String(fields.get(key) ?? '');
const integer = (fields: FormData, key: string) => Number(read(fields, key));
const clearText = () => notify('');

function notify(message: string, error = false) {
  status.textContent = message;
  status.toggleAttribute('data-error', error);
}

function report(error: unknown) {
  const message = error instanceof Error ? error.message : '保存或读取失败，请稍后重试。';
  notify(`操作未完成。 ${message}`, true);
  if (dialog?.open) dialog.querySelector<HTMLElement>('[role="alert"]')!.textContent = message;
}

function updateView(target: View, section?: string) {
  clearText();
  active = target;
  render();
  const destination = section ? document.getElementById(section) : content;
  destination?.focus({ preventScroll: true });
  (section ? destination : container)?.scrollIntoView({ block: 'start', behavior: 'instant' });
}

function render() {
  if (legacySnapshot) {
    const time = localClock(Date.now(), legacySnapshot.settings.timezone);
    content.innerHTML = `<section class="study-card">
      <h2>旧数据只读模式</h2>
      <p>数据库升级未完成。你可以查看历史或导出完整的 v1 备份。原计时会保留，升级成功后可以继续。</p>
      <div class="study-actions">
        <button type="button" class="study-action primary" data-action="export-legacy">导出 v1 备份</button>
        <button type="button" class="study-action" data-action="retry-upgrade">重试升级</button>
      </div>
    </section>${history(legacySnapshot, time, filters, true)}`;
    content.setAttribute('aria-busy', 'false');
    return;
  }
  const open = [...content.querySelectorAll<HTMLDetailsElement>('details[data-keep][open]')].map(item => item.dataset.keep);
  const time = now();
  renderedMinute = `${time.day}:${time.minute}`;
  const current = currentWeek();
  let markup: string;
  switch (active) {
    case 'overview': markup = overview(data, time); break;
    case 'plan':
      markup = planView(data, time, week || current, {
        draftMinutes: draft?.week === week ? draft?.minutes : undefined,
        draftFocus: draft?.week === week ? draft?.focus : undefined,
        exam: data.exams.find(exam => exam.id === examId),
      });
      break;
    case 'records':
      markup = recordsView(data, time, filters, data.sessions.find(session => session.id === sessionId));
      break;
    case 'policy': markup = policy.innerHTML; break;
    case 'settings': markup = settingsView(data); break;
    case 'review': markup = reviewView(data, time, reviewWeek || current); break;
  }
  content.innerHTML = markup;
  content.setAttribute('aria-busy', 'false');
  for (const item of content.querySelectorAll<HTMLDetailsElement>('details[data-keep]')) {
    if (open.includes(item.dataset.keep)) item.open = true;
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    if (button.dataset.view === active || (active === 'review' && button.dataset.view === 'records')) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  }
}

async function commit(change: Parameters<StudyRepository['update']>[0], message: string) {
  data = await repository.update(change);
  notify(message);
}

function showDialog(title: string, body: string) {
  dialog?.close();
  const element = document.createElement('dialog');
  const previousFocus = document.activeElement;
  element.className = 'study-card';
  element.setAttribute('aria-labelledby', 'study-dialog-title');
  element.innerHTML = `<h2 id="study-dialog-title">${title}</h2><div class="study-status" data-error role="alert"></div>${body}`;
  element.addEventListener('close', () => {
    element.remove();
    if (dialog === element) dialog = undefined;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    else content.focus();
  }, { once: true });
  container.append(element);
  dialog = element;
  element.showModal();
}

function readPlan(fields: FormData) {
  const days = Array.from({ length: 7 }, (_, index) => integer(fields, `d${index}`));
  const before = days.map((_, index) => {
    const value = read(fields, `b${index}`);
    return value === '' ? null : Number(value);
  });
  return { days, before };
}

function previewPlan(form: HTMLFormElement) {
  if (!form.checkValidity()) return;
  const fields = new FormData(form);
  const { days, before } = readPlan(fields);
  const budget = calculateBudget(form.dataset.value!, days, before, data.exams, data.settings);
  const manual = fields.has('manual') ? tracks.map((_, index) => integer(fields, `t${index}`)) as Split : null;
  const matchesBudget = manual?.reduce((total, value) => total + value, 0) === budget.allocatable;
  const preview = form.querySelector<HTMLElement>('#study-budget-preview')!;
  preview.innerHTML = budgetPreview(budget, matchesBudget ? manual : null);
  if (manual && !matchesBudget) {
    const mismatch = document.createElement('p');
    mismatch.className = 'study-muted';
    mismatch.textContent = '自定目标尚未配平，以上显示自动分配。';
    preview.append(mismatch);
  }
  for (const field of form.querySelectorAll<HTMLElement>('[data-day-phase]')) {
    field.textContent = allocationText(budget.days[Number(field.dataset.dayPhase)]);
  }
  if (!manual) {
    tracks.forEach((_, index) => {
      const target = form.elements.namedItem(`t${index}`) as HTMLInputElement;
      target.value = String(budget.targets[index]);
    });
  }
}

function downloadBackup(snapshot: StudyData) {
  const url = URL.createObjectURL(exportBackupBlob(snapshot));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `hikari-study-${localClock(Date.now(), snapshot.settings.timezone).day}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function replace<T>(items: T[], predicate: (item: T) => boolean, value: T) {
  const index = items.findIndex(predicate);
  if (index >= 0) items[index] = value;
  else items.push(value);
}

async function saveForm(form: HTMLFormElement) {
  const fields = new FormData(form);
  const key = form.dataset.value ?? '';
  const text = (name: string) => read(fields, name).trim();
  const session = form.dataset.form === 'session' || form.dataset.form === 'finish-timer';
  if (session) {
    const finishing = form.dataset.form === 'finish-timer';
    const day = text('day');
    if (!validDay(day) || day > now().day) throw new Error('学习日期必须是今天或更早。');
    const record: Session = {
      id: key || crypto.randomUUID(), day, subjectId: text('subjectId'),
      minutes: integer(fields, 'minutes'), quality: text('quality'), note: text('note'),
    };
    await commit(state => {
      if (finishing) {
        if (!state.timer || state.timer.id !== key) throw new Error('该计时已在另一个窗口结束。');
        requireCurrent(state.timer, data.timer);
        record.subjectId = state.timer.subjectId;
        state.timer = null;
      } else if (key) {
        requireCurrent(state.sessions.find(item => item.id === key), data.sessions.find(item => item.id === key));
      }
      replace(state.sessions, item => item.id === record.id, record);
    }, '学习记录已保存。');
    sessionId = '';
    dialog?.close();
  } else {
    switch (form.dataset.form) {
      case 'timer': {
        const instant = Date.now();
        await commit(state => {
          if (state.timer) throw new Error('已有一项活动计时。');
          const subject = state.subjects.find(item => item.id === text('subjectId') && !item.archived);
          if (!subject) throw new Error('请选择一个当前可用的科目或项目。');
          state.timer = { id: crypto.randomUUID(), day: localClock(instant, state.settings.timezone).day, subjectId: subject.id, startedAt: instant, elapsedMs: 0, runningSince: instant };
        }, '计时已开始。');
        break;
      }
      case 'plan': {
        const { days, before } = readPlan(fields);
        const manual = fields.has('manual') ? tracks.map((_, index) => integer(fields, `t${index}`)) as Split : null;
        await commit(state => {
          if (key < monday(localClock(Date.now(), state.settings.timezone).day)) throw new Error('这周已结束，预算快照已保留。');
          if (before.some((value, index) => value !== null && value > days[index])) throw new Error('考前分钟数不可超过当日可用时间。');
          const budget = calculateBudget(key, days, before, state.exams, state.settings);
          if (manual && manual.reduce((sum, value) => sum + value, 0) !== budget.allocatable) {
            throw new Error(`自定目标合计应为 ${budget.allocatable} 分钟。`);
          }
          const previous = state.plans.find(plan => plan.week === key);
          requireCurrent(previous, data.plans.find(plan => plan.week === key));
          replace(state.plans, plan => plan.week === key, {
            week: key, minutes: days, beforeExam: before, budget, manual, focus: text('focus'),
            previousTargets: previous ? targetsOf(previous) : null, revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now(),
          });
        }, '周计划快照已保存。');
        draft = undefined;
        break;
      }
      case 'exam': {
        const exam: Exam = {
          id: key || crypto.randomUUID(), name: text('name'), subjectId: text('subjectId'), day: text('day'),
          start: text('start'), end: text('end'), importance: text('importance') as Exam['importance'],
          mastery: text('mastery') as Exam['mastery'], status: text('status') as Exam['status'], note: text('note'),
        };
        if (exam.start && exam.end && exam.start >= exam.end) throw new Error('考试结束时间必须晚于开始时间。');
        await commit(state => {
          const previous = state.exams.find(item => item.id === key);
          if (key) requireCurrent(previous, data.exams.find(item => item.id === key));
          if (exam.status === 'completed') exam.closedAt = previous?.closedAt ?? Date.now();
          replace(state.exams, item => item.id === exam.id, exam);
        }, '考试已保存，当前阶段已重新计算。');
        examId = '';
        break;
      }
      case 'settings': {
        const timezone = text('timezone');
        if (!validTimezone(timezone)) throw new Error('请输入有效的 IANA 时区，例如 Asia/Shanghai。');
        const ratios = Object.fromEntries(phases.map(phase => [
          phase, tracks.map((_, index) => integer(fields, `ratio-${phase}-${index}`)),
        ])) as Settings['ratios'];
        if (phases.some(phase => ratios[phase].reduce((sum, value) => sum + value, 0) !== 100)) {
          throw new Error('每个阶段的三类比例相加必须为 100%。');
        }
        await commit(state => {
          requireCurrent(state.settings, data.settings);
          state.settings = {
            timezone, ratios, buffer: integer(fields, 'buffer'), override: text('override') as Settings['override'],
            vacation: fields.has('vacation'), untimedExam: text('untimedExam') as Settings['untimedExam'],
          };
        }, '设置已保存。已有计划仍使用原预算快照。');
        break;
      }
      case 'subject-add':
        await commit(state => {
          state.subjects.push({ id: crypto.randomUUID(), track: key as Track, name: text('name'), archived: false });
        }, '已添加。');
        break;
      case 'subject':
        await commit(state => {
          const subject = state.subjects.find(item => item.id === key);
          if (!subject) throw new Error('这个科目已不存在。');
          requireCurrent(subject, data.subjects.find(item => item.id === key));
          if (subject.track === 'school' && subject.name !== text('name')) {
            state.academic.aliases.push({ subjectId: subject.id, name: subject.name });
          }
          subject.name = text('name');
        }, '名称已更新。');
        break;
      case 'review': {
        const review: Review = {
          week: key, balance: text('balance'), knowledge: text('knowledge'), results: text('results'),
          issues: text('issues'), nextFocus: text('nextFocus'),
        };
        await commit(state => {
          requireCurrent(state.reviews.find(item => item.week === key), data.reviews.find(item => item.week === key));
          replace(state.reviews, item => item.week === key, review);
        }, '复盘已保存。');
        break;
      }
    }
  }
  render();
}

async function action(button: HTMLButtonElement) {
  if (button.dataset.view) {
    const view = button.dataset.view as View;
    if (view === 'plan') week = currentWeek();
    updateView(view);
    return;
  }
  const key = button.dataset.value ?? '';
  switch (button.dataset.action) {
    case 'settings': updateView('settings'); return;
    case 'plan': week = currentWeek(); updateView('plan'); return;
    case 'record': sessionId = ''; updateView('records', 'study-record'); return;
    case 'timer': updateView('records', 'study-timer'); return;
    case 'exams': if (active !== 'plan') week = currentWeek(); examId = ''; updateView('plan', 'study-exams'); return;
    case 'review': reviewWeek = key || currentWeek(); updateView('review'); return;
    case 'edit-exam': examId = key; updateView('plan', 'study-exams'); return;
    case 'edit-session': sessionId = key; updateView('records', 'study-record'); return;
    case 'select-week':
      if (!validDay(key) || !validDay(shiftDay(key, 6))) return;
      week = key;
      updateView('plan');
      return;
    case 'copy-week': {
      const form = button.form!;
      const previous = data.plans.find(plan => plan.week === shiftDay(form.dataset.value!, -7));
      if (previous) {
        previous.minutes.forEach((minutes, index) => {
          (form.elements.namedItem(`d${index}`) as HTMLInputElement).value = String(minutes);
        });
        previewPlan(form);
        notify('已填入上周可用时间。保存周计划后生效。');
      }
      return;
    }
    case 'next-week': {
      week = shiftDay(key, 7);
      const currentPlan = data.plans.find(plan => plan.week === key);
      const nextPlan = data.plans.find(plan => plan.week === week);
      draft = nextPlan ? undefined : {
        week, minutes: currentPlan?.minutes,
        focus: (button.form?.elements.namedItem('nextFocus') as HTMLTextAreaElement | null)?.value,
      };
      updateView('plan');
      return;
    }
    case 'quick-minute':
      (button.form?.elements.namedItem('minutes') as HTMLInputElement).value = key;
      return;
    case 'record-page':
      filters.page = Number(key);
      render();
      focusHistory();
      return;
    case 'close-dialog': dialog?.close(); return;
    case 'export': downloadBackup(await repository.read()); notify('备份文件已生成。'); return;
    case 'import': container.querySelector<HTMLInputElement>('#study-backup-file')?.click(); return;
    case 'reset-ratios':
      if (!confirm('恢复五个学习阶段的默认比例和 10% 机动时间？已保存的周预算继续使用原快照。')) return;
      await commit(state => {
        requireCurrent(state.settings, data.settings);
        const defaults = defaultSettings();
        state.settings.ratios = defaults.ratios;
        state.settings.buffer = defaults.buffer;
      }, '已恢复默认比例与机动时间。');
      break;
    case 'delete-exam':
      if (!confirm('删除这场考试？')) return;
      await commit(state => {
        requireCurrent(state.exams.find(item => item.id === key), data.exams.find(item => item.id === key));
        state.exams = state.exams.filter(exam => exam.id !== key);
      }, '考试已删除。');
      if (examId === key) examId = '';
      break;
    case 'complete-exam':
    case 'cancel-exam':
      await commit(state => {
        const exam = state.exams.find(item => item.id === key);
        if (!exam) throw new Error('该考试已不存在。');
        requireCurrent(exam, data.exams.find(item => item.id === key));
        exam.status = button.dataset.action === 'complete-exam' ? 'completed' : 'cancelled';
        exam.closedAt = exam.status === 'completed' ? Date.now() : undefined;
      }, '考试状态已更新，当前阶段已重新计算。');
      break;
    case 'delete-session':
      if (!confirm('删除这条学习记录？相关统计会立即更新。')) return;
      await commit(state => {
        requireCurrent(state.sessions.find(item => item.id === key), data.sessions.find(item => item.id === key));
        state.sessions = state.sessions.filter(session => session.id !== key);
      }, '学习记录已删除。');
      if (sessionId === key) sessionId = '';
      break;
    case 'archive':
    case 'move-up':
    case 'move-down':
      await commit(state => {
        const index = state.subjects.findIndex(subject => subject.id === key);
        const subject = state.subjects[index];
        if (!subject) throw new Error('这个科目已不存在。');
        requireCurrent(subject, data.subjects.find(item => item.id === key));
        if (button.dataset.action === 'archive') {
          subject.archived = !subject.archived;
          return;
        }
        const peers = state.subjects.filter(item => item.track === subject.track);
        const offset = button.dataset.action === 'move-up' ? -1 : 1;
        const adjacent = peers[peers.indexOf(subject) + offset];
        if (adjacent) {
          const adjacentIndex = state.subjects.indexOf(adjacent);
          [state.subjects[index], state.subjects[adjacentIndex]] = [adjacent, subject];
        }
      }, '科目与项目设置已更新。');
      break;
    case 'pause-timer':
    case 'resume-timer':
    case 'finish': {
      const finishing = button.dataset.action === 'finish';
      const instant = Date.now();
      await commit(state => {
        if (state.timer?.id !== key) throw new Error('该计时已在另一个窗口结束。');
        requireCurrent(state.timer, data.timer);
        const timer = state.timer;
        if (timer.runningSince !== null && button.dataset.action !== 'resume-timer') {
          timer.elapsedMs = timerMs(timer, instant);
          timer.runningSince = null;
        } else if (timer.runningSince === null && button.dataset.action === 'resume-timer') {
          timer.runningSince = Math.max(timer.startedAt, instant);
        }
      }, finishing ? '计时已暂停，请核对记录时长。' : '计时状态已保存。');
      if (finishing) {
        const minutes = Math.max(1, Math.round(timerMs(data.timer!, instant) / 60_000));
        render();
        showDialog('结束并保存', sessionForm(data, now(), undefined, Math.min(minutes, 1440)));
        return;
      }
      break;
    }
    case 'discard-timer':
      if (!confirm('放弃本次计时？')) return;
      await commit(state => {
        if (state.timer?.id !== key) throw new Error('该计时已在另一个窗口结束。');
        requireCurrent(state.timer, data.timer);
        state.timer = null;
      }, '本次计时已放弃。');
      break;
    default: return;
  }
  render();
}

async function handleImport(file: File) {
  const restored = await importBackupFile(file);
  const before = await repository.read();
  showDialog('恢复本地备份', `<p>备份包含 ${restored.sessions.length} 条学习记录、${restored.exams.length} 场考试、${restored.plans.length} 份周计划和 ${restored.reviews.length} 份复盘。恢复后将覆盖本浏览器的 Study 和 Academic 数据（含 ${restored.academic.terms.length} 个学期）。备份中${restored.timer ? '有' : '没有'}未结算计时。可以先导出当前数据。</p>
    <div class="study-actions"><button class="study-action" type="button" data-action="backup-before">先导出当前数据</button>
    <button class="study-action danger" type="button" data-action="confirm-restore">确认覆盖并恢复</button>
    <button class="study-action" type="button" data-action="close-dialog">取消</button></div>`);
  dialog?.querySelector('[data-action="backup-before"]')?.addEventListener('click', () => {
    try { downloadBackup(before); }
    catch (error) { report(error); }
  });
  dialog?.querySelector('[data-action="confirm-restore"]')?.addEventListener('click', () => run(async () => {
    data = await repository.restore(before, restored);
    notify('完整备份已恢复。');
    dialog?.close();
    week = '';
    reviewWeek = '';
    examId = '';
    sessionId = '';
    draft = undefined;
    filters = { track: '', subject: '', week: '', page: 0 };
    render();
  }));
}

function focusHistory(name?: string) {
  const replacement = name ? content.querySelector<HTMLSelectElement>(`[data-form="filter"] select[name="${name}"]`) : null;
  (replacement ?? content.querySelector<HTMLSelectElement>('[data-form="filter"] select'))?.focus({ preventScroll: true });
}

async function run(task: () => Promise<void>) {
  if ((!repository && !legacySnapshot) || busy) return;
  busy = true;
  try {
    await task();
  } catch (error) {
    report(error);
  } finally {
    busy = false;
  }
}

container.addEventListener('click', event => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-action], button[data-view]');
  if (!button) return;
  if (legacySnapshot) {
    switch (button.dataset.action) {
      case 'export-legacy':
        void run(async () => {
          downloadBackup(await readLegacyStudy());
          notify('v1 备份文件已生成。');
        });
        break;
      case 'retry-upgrade':
        if (!busy) location.reload();
        break;
      case 'record-page':
        filters.page = Number(button.dataset.value);
        render();
        focusHistory();
        break;
    }
    return;
  }
  if (!repository) {
    if (button.dataset.view === 'policy') {
      content.replaceChildren(policy.content.cloneNode(true));
      content.setAttribute('aria-busy', 'false');
    }
    return;
  }
  void run(() => action(button));
});

container.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  event.preventDefault();
  if (repository && form.dataset.form !== 'filter') void run(() => saveForm(form));
});

container.addEventListener('change', event => {
  const control = event.target as HTMLInputElement | HTMLSelectElement;
  if (control.id === 'study-week-picker') {
    week = control.value;
    render();
    document.getElementById(control.id)?.focus({ preventScroll: true });
    return;
  }
  const form = control.form;
  if (!form || (!data && !legacySnapshot)) return;
  if (form.dataset.form === 'filter') {
    const fields = new FormData(form);
    filters = { week: read(fields, 'week'), track: read(fields, 'track'),
      subject: control.name === 'track' ? '' : read(fields, 'subject'), page: 0 };
    render();
    focusHistory(control.name);
  }
  if (control.name === 'track' && (form.dataset.form === 'session' || form.dataset.form === 'timer')) {
    const track = control.value as Track;
    (form.elements.namedItem('subjectId') as HTMLSelectElement).innerHTML = subjectOptions(data, track);
    const quality = form.elements.namedItem('quality') as HTMLSelectElement | null;
    if (quality) quality.innerHTML = qualityOptions(track);
  }
});

container.addEventListener('input', event => {
  const control = event.target as HTMLInputElement;
  if (control.form?.dataset.form === 'plan' && control.name !== 'focus') previewPlan(control.form);
});

container.addEventListener('change', event => {
  const control = event.target as HTMLInputElement;
  if (control.id !== 'study-backup-file' || !control.files?.length) return;
  const file = control.files[0];
  control.value = '';
  if (repository) void run(() => handleImport(file));
});

function updateClock() {
  if (!data || document.hidden) return;
  const clock = document.getElementById('study-timer-clock');
  if (clock) clock.textContent = timerText(data, Date.now());
  const warning = document.getElementById('study-timer-long');
  if (warning && data.timer) warning.hidden = timerMs(data.timer, Date.now()) < 14_400_000;
  const time = now();
  if (busy || dialog?.open || renderedMinute === `${time.day}:${time.minute}`) return;
  if (active === 'overview') {
    render();
  } else if (active === 'plan') {
    const stage = stageText(data, time);
    content.querySelector<HTMLElement>('[data-stage-name]')!.textContent = phaseNames[stage.phase];
    content.querySelector<HTMLElement>('[data-stage-reason]')!.textContent = stage.reason;
  }
  renderedMinute = `${time.day}:${time.minute}`;
}

async function refresh() {
  if (!repository || busy || dialog?.open) {
    pendingRefresh = true;
    return;
  }
  if (document.activeElement?.closest('form')) {
    pendingRefresh = true;
    return;
  }
  pendingRefresh = false;
  const next = await repository.read();
  if (busy || dialog?.open || document.activeElement?.closest('form')) {
    pendingRefresh = true;
    return;
  }
  if (JSON.stringify(data) !== JSON.stringify(next)) {
    data = next;
    render();
  }
  updateClock();
}

try {
  repository = await openStudyRepository();
  data = await repository.read();
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(channelName);
    channel.addEventListener('message', () => void refresh().catch(report));
  }
  window.addEventListener('focus', () => void refresh().catch(report));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh().catch(report);
  });
  setInterval(() => {
    updateClock();
    if (pendingRefresh && !document.hidden && !busy && !dialog?.open && !document.activeElement?.closest('form')) {
      void refresh().catch(report);
    }
  }, 1000);
  render();
} catch (error) {
  report(error);
  if (error instanceof LegacyStudyUpgradeError) {
    try {
      legacySnapshot = await readLegacyStudy();
    } catch {
      // A damaged or already migrated database is not a readable v1 snapshot.
    }
  }
  if (legacySnapshot) {
    for (const button of container.querySelectorAll<HTMLButtonElement>('button[data-view]')) button.disabled = true;
    render();
  } else {
    content.setAttribute('aria-busy', 'false');
    content.textContent = '暂时无法打开本地数据库。请检查浏览器存储权限，关闭其他工作台窗口后刷新。如需从备份恢复，请打开学业中心。';
  }
}

setupOffline(container.querySelector<HTMLElement>('#study-pwa')!);
