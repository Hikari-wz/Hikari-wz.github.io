import {
  examStatusNames, importanceNames, masteryNames, phases, phaseNames, qualityFor, tracks, trackNames,
  type Exam, type Review, type Session, type Split, type StudyData, type Subject, type Track, type WeeklyPlan,
} from './model.ts';
import { calculateBudget, examCutoff, phaseAt, timerMs, upcomingExams, type LocalTime } from './planning.ts';
import { budgetText, guidance, percent, recordedWeeks, remainingAvailable, summarize, targetsOf, weekSessions } from './statistics.ts';
import { dayDistance, daysOf, duration, monday, shiftDay } from './time.ts';

export const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const e = escape;
export const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const weekLabel = (week: string) => `${week} 至 ${shiftDay(week, 6).slice(5)}`;
const option = (value: string, label: string, selected: string) =>
  `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(label)}</option>`;
export const options = (labels: Record<string, string>, selected: string) =>
  Object.entries(labels).map(([value, label]) => option(value, label, selected)).join('');
export const qualityOptions = (track: Track, selected = '') =>
  option('', '可选', selected) + qualityFor(track).map(quality => option(quality, quality, selected)).join('');
export const subjectOptions = (data: StudyData, track: Track, selected = '') =>
  option('', '选择科目或项目', selected) + data.subjects
    .filter(subject => subject.track === track && (!subject.archived || subject.id === selected))
    .map(subject => option(subject.id, subject.name + (subject.archived ? '（已归档）' : ''), selected)).join('');

const card = (title: string, content: string, className = '') =>
  `<section class="study-card ${className}"><h2>${title}</h2>${content}</section>`;
const columns = (left: string, right: string, layout = 'study-equal') =>
  `<div class="study-columns ${layout}"><div class="study-stack">${left}</div><div class="study-stack">${right}</div></div>`;
const muted = (text: string) => `<p class="study-muted">${text}</p>`;
const actions = (...buttons: string[]) => `<div class="study-actions">${buttons.join('')}</div>`;
export const button = (label: string, action: string, cls = '', value = '') =>
  `<button type="button" class="study-action ${cls}" data-action="${action}" data-value="${e(value)}">${label}</button>`;
const submit = (label: string) => `<button class="study-action primary" type="submit">${label}</button>`;
const label = (text: string, control: string) => `<label class="study-field">${text}${control}</label>`;
const select = (text: string, name: string, opts: string, required = false) =>
  label(text, `<select name="${name}" ${required ? 'required' : ''}>${opts}</select>`);
const input = (text: string, name: string, value: string | number, attrs: string) =>
  label(text, `<input name="${name}" value="${e(value)}" ${attrs}>`);
const textInput = (text: string, name: string, value = '', required = false) =>
  input(text, name, value, `type="text" maxlength="120" ${required ? 'required' : ''}`);
const numberInput = (text: string, name: string, value: string | number, min: number, max: number, required = true) =>
  input(text, name, value, `type="number" inputmode="numeric" min="${min}" max="${max}" step="1" ${required ? 'required' : ''}`);
const dateInput = (text: string, name: string, value: string, max = '9998-12-31', required = true) =>
  input(text, name, value, `type="date" min="1900-01-01" max="${max}" ${required ? 'required' : ''}`);
const textarea = (text: string, name: string, value = '') =>
  label(text, `<textarea name="${name}" maxlength="2000" rows="2">${e(value)}</textarea>`);
const fields = (...content: string[]) => `<div class="study-fields">${content.join('')}</div>`;
const list = (items: string[]) => `<ul class="study-list">${items.map(item => `<li>${item}</li>`).join('')}</ul>`;
const form = (kind: string, content: string, value = '') =>
  `<form class="study-form" data-form="${kind}" data-value="${e(value)}">${content}</form>`;
const trackName = (track: Track) =>
  `<span class="study-track-name" data-track="${track}">${trackNames[track]}</span>`;
export const subjectName = (data: StudyData, id: string) => data.subjects.find(subject => subject.id === id)?.name ?? '未知科目';

function projectProgress(actual: Split, targets?: Split, progress = true) {
  const total = actual.reduce((sum, value) => sum + value, 0);
  return tracks.map((track, index) => {
    const target = targets?.[index];
    const done = actual[index];
    const rate = percent(done, target ?? 0);
    const remaining = Math.max(0, (target ?? 0) - done);
    return `<div class="study-progress" data-track="${track}">
      <div class="study-between">${trackName(track)} <strong>${duration(done)}${target !== undefined ? ` / ${duration(target)}` : ''}</strong></div>
      ${progress && target ? `<meter aria-label="${trackNames[track]}预算完成进度" min="0" max="${target}" value="${Math.min(done, target)}"></meter>` : ''}
      <small>实际占比 ${percent(done, total) ?? '—'}${total ? '%' : ''}${target === undefined ? '' : rate === null ? ` · 零预算${done ? ' · 超出 ' + duration(done) : ''}` :
        ` · 完成 ${rate}% · ${done > target ? '超出 ' + duration(done - target) : '剩余 ' + duration(remaining)}`}</small>
    </div>`;
  }).join('');
}

function outcomes(data: StudyData, sessions: Session[], limit = 5) {
  const notes = sessions.filter(session => session.note).sort((a, b) => b.day.localeCompare(a.day)).slice(0, limit);
  return notes.length ? list(notes.map(session =>
    `<strong>${e(subjectName(data, session.subjectId))}</strong> <small>${e(session.day)}</small><p>${e(session.note)}</p>`))
    : muted('暂无成果。补录学习时可以留一句话。');
}

function upcomingImportant(data: StudyData, now: LocalTime) {
  return upcomingExams(data.exams, now, data.settings).filter(exam => exam.importance === 'important' && dayDistance(now.day, exam.day) <= 28);
}
const countdown = (now: LocalTime, exam: Exam) => dayDistance(now.day, exam.day) ? `还有 ${dayDistance(now.day, exam.day)} 天` : '今天';

export function stageText(data: StudyData, time: LocalTime) {
  const stage = phaseAt(data.exams, time, data.settings);
  const reason = stage.exam && stage.distance <= 28 ? `${stage.exam.name} · ${countdown(time, stage.exam)}`
    : data.settings.vacation ? '已开启假期 · 未来 28 天无重要考试' : '未来 28 天无重要考试';
  return { ...stage, reason: data.settings.override === 'auto' ? reason : `手动覆盖 · 自动建议为${phaseNames[stage.automatic]}（${reason}）` };
}

export function overview(data: StudyData, now: LocalTime) {
  const week = monday(now.day);
  const plan = data.plans.find(plan => plan.week === week);
  const sessions = weekSessions(data, week).filter(session => session.day <= now.day);
  const stats = summarize(data, sessions);
  const stage = stageText(data, now);
  const advice = guidance(data, now, stage.phase, plan);
  const closest = upcomingExams(data.exams, now, data.settings)[0];
  const urgent = upcomingImportant(data, now);
  const target = plan?.budget.allocatable;
  const totalRate = percent(stats.total, target ?? 0);
  const hero = `<section class="study-card study-hero">
    <p class="study-muted">${weekLabel(week)}</p><h2>当前学习阶段</h2>
    <strong class="study-total">${phaseNames[stage.phase]}</strong>
    <p>${e(stage.reason)}</p>
    ${actions(button('快速补录', 'record', 'primary'), button(data.timer ? '查看计时' : '开始计时', 'timer'))}</section>`;
  const metrics = plan ? `<dl class="study-metrics">
    <div><dt>计划可用</dt><dd>${duration(plan.budget.available)}</dd></div>
    <div><dt>机动时间</dt><dd>${duration(plan.budget.reserve)}</dd></div>
    <div><dt>预计还可用</dt><dd>${duration(remainingAvailable(plan, sessions, now))}</dd></div>
  </dl>` : muted('本周还没有计划。');
  const progress = card('本周投入', `<p class="study-total">${duration(stats.total)}</p>${metrics}
    ${target ? muted(`可分配 ${duration(target)} · 总预算完成 ${totalRate}% ${plan?.revision && plan.revision > 1 ? ' · 计划已调整' : ''}`) : ''}
    ${projectProgress(stats.actual, plan && targetsOf(plan))}
    ${actions(button(plan ? '查看周计划' : '制定周计划', 'plan', !plan ? 'primary' : ''))}`);
  const exams = card('最近考试', `${closest ? `<p><strong>${e(closest.name)}</strong> · ${countdown(now, closest)}</p>` : muted('近期没有待考事项。')}
    ${urgent.length ? `<h3>未来 28 天的重要考试</h3>${list(urgent.map(exam => `${e(exam.name)} <small>${e(exam.day)}</small>`))}` : ''}
    ${actions(button('考试管理', 'exams'))}`);
  const next = card('下一步建议', `<p>${e(advice.next)}</p>
    ${advice.messages.length ? `<h3>学习提醒</h3>${list(advice.messages.map(e))}` : ''}
    ${week === shiftDay(now.day, -6) ? actions(button('开始本周复盘', 'review', 'primary')) : ''}`);
  const breakdown = stats.subjects.length ? card('科目与项目', list(stats.subjects.map(subject =>
    `<div class="study-between"><span>${e(subject.name)}</span><strong>${duration(subject.minutes)}</strong></div>`))) : '';
  return columns(hero + progress + breakdown, next + exams + card('本周成果', outcomes(data, sessions)), 'study-overview');
}

function examEntry(data: StudyData, exam: Exam, ended: boolean) {
  const status = ended && exam.status === 'scheduled' ? '已结束' : examStatusNames[exam.status];
  return `<strong>${e(exam.name)}</strong> · ${e(subjectName(data, exam.subjectId))}
    <div class="study-muted">${e(exam.day)} ${e([exam.start, exam.end].filter(Boolean).join(' – '))}
      · ${importanceNames[exam.importance]} · ${masteryNames[exam.mastery]} · ${status}</div>
    ${exam.note ? `<p>${e(exam.note)}</p>` : ''}
    ${actions(button('编辑', 'edit-exam', '', exam.id), ...(exam.status === 'scheduled' ? [
      button('标记完成', 'complete-exam', '', exam.id), button('取消考试', 'cancel-exam', '', exam.id),
    ] : []), button('删除', 'delete-exam', 'danger', exam.id))}`;
}

export function examForm(data: StudyData, now: LocalTime, exam?: Exam) {
  const subjects = data.subjects.filter(subject => !subject.archived || subject.id === exam?.subjectId);
  return form('exam', fields(
    textInput('考试名称', 'name', exam?.name, true),
    select('对应科目', 'subjectId', option('', '选择科目', exam?.subjectId ?? '') + tracks.map(track =>
      `<optgroup label="${trackNames[track]}">${subjects.filter(subject => subject.track === track).map(subject =>
        option(subject.id, subject.name, exam?.subjectId ?? '')).join('')}</optgroup>`).join(''), true),
    dateInput('考试日期', 'day', exam?.day ?? now.day),
    select('重要程度', 'importance', options(importanceNames, exam?.importance ?? 'important')),
    input('开始时间（可选）', 'start', exam?.start ?? '', 'type="time"'),
    input('结束时间（可选）', 'end', exam?.end ?? '', 'type="time"'),
    select('掌握程度', 'mastery', options(masteryNames, exam?.mastery ?? 'new')),
    select('考试状态', 'status', options(examStatusNames, exam?.status ?? 'scheduled')),
  ) + textarea('备注（可选）', 'note', exam?.note) + actions(submit(exam ? '保存修改' : '添加考试'),
    ...(exam ? [button('取消编辑', 'exams')] : [])), exam?.id);
}

export function budgetPreview(budget: WeeklyPlan['budget'], manual?: Split | null) {
  return `${muted(budgetText(budget))}<dl class="study-metrics">${tracks.map((track, index) =>
    `<div><dt>${trackName(track)}</dt><dd>${duration((manual ?? budget.targets)[index])}</dd></div>`).join('')}</dl>`;
}
export function allocationText(day: WeeklyPlan['budget']['days'][number]) {
  return day.parts.filter(part => part.minutes > 0).map(part =>
    `${phaseNames[part.phase]}${day.parts.length > 1 ? ` ${part.minutes} 分` : ''}`).join(' · ') || phaseNames[day.parts[0].phase];
}
export function planView(data: StudyData, now: LocalTime, week: string, options: {
  draftMinutes?: number[]; draftFocus?: string; exam?: Exam;
} = {}) {
  const current = monday(now.day);
  const saved = data.plans.find(plan => plan.week === week);
  const baseline = saved?.minutes ?? Array(7).fill(0) as number[];
  const minutes = options.draftMinutes ?? baseline;
  const before = saved?.beforeExam ?? Array(7).fill(null) as null[];
  const budget = calculateBudget(week, minutes, before, data.exams, data.settings);
  const historic = week < current;
  const actual = summarize(data, weekSessions(data, week).filter(session => session.day <= now.day)).actual;
  const active = upcomingExams(data.exams, now, data.settings);
  const upcoming = new Set(active.map(exam => exam.id));
  const ended = data.exams.filter(exam => !upcoming.has(exam.id)).sort((a, b) => b.day.localeCompare(a.day));
  const stage = stageText(data, now);
  const previous = data.plans.find(plan => plan.week === shiftDay(week, -7));
  const pager = `<div class="study-between study-pager">${button('上周', 'select-week', '', shiftDay(week, -7))}
    <strong>${weekLabel(week)}</strong>${button('下周', 'select-week', '', shiftDay(week, 7))}</div>`;
  const editor = form('plan', `<p class="study-muted">按每天预计可自主支配的分钟数填写，休息日填 0。考试跨阶段时，可填写最后一场重要考试结束前的学习分钟数。留空按 08:00–22:00 的时间比例估算。</p>
    <div>${daysOf(week).map((day, index) => {
      const examDay = data.exams.some(exam => exam.day === day && exam.importance === 'important' &&
        exam.status !== 'cancelled' && examCutoff(exam, data.settings) > 0);
      return `<div class="study-day"><div><h3>${weekdays[index]} · ${day.slice(5)}</h3><small data-day-phase="${index}">${allocationText(budget.days[index])}</small></div>
        ${numberInput('可用（分钟）', `d${index}`, minutes[index], 0, 1440)}
        ${examDay ? numberInput('考前（分钟，可选）', `b${index}`, before[index] ?? '', 0, 1440, false) : ''}</div>`;
    }).join('')}</div>
    ${textarea('本周重点（可选）', 'focus', options.draftFocus ?? saved?.focus ?? '')}
    <div id="study-budget-preview">${budgetPreview(budget, saved?.manual && saved.budget.allocatable === budget.allocatable ? saved.manual : null)}</div>
    <details ${saved?.manual ? 'open' : ''}><summary>直接调整三类目标</summary>
      <label class="study-check"><input name="manual" type="checkbox"${saved?.manual ? ' checked' : ''}>使用自定目标</label>
      <div class="study-ratios">${tracks.map((track, index) =>
        numberInput(trackNames[track] + '（分）', `t${index}`, (saved?.manual ?? budget.targets)[index], 0, 10080)).join('')}</div>
      ${muted('三类目标合计需等于可分配预算。')}</details>
    ${actions(submit(saved ? '更新周计划' : '保存周计划'), ...(previous ? [button('复制上周可用时间', 'copy-week')] : []))}`, week);
  const snapshot = saved ? `${budgetPreview(saved.budget, saved.manual)}${saved.focus ? `<p class="study-note">${e(saved.focus)}</p>` : ''}
    ${saved.revision > 1 ? muted(`已调整 · 第 ${saved.revision} 版${saved.previousTargets ? ` · 上一版 ${saved.previousTargets.map(duration).join(' / ')}` : ''}`) : ''}
    ${historic ? list(saved.budget.days.map((day, index) => `${weekdays[index]} · ${duration(saved.minutes[index])} · ${allocationText(day)}`)) : ''}`
    : muted('这一周没有保存过预算快照。');
  const availableWeeks = [...new Set([week, current, ...data.plans.map(item => item.week)])].sort().reverse();
  const weekPicker = availableWeeks.length > 1 ? label('查看已保存周或本周',
    `<select id="study-week-picker">${availableWeeks.map(date => option(date, weekLabel(date), week)).join('')}</select>`) : '';
  const planCard = card('每周时间分配', pager + weekPicker +
    (historic ? snapshot : `${saved ? `<details><summary>查看已保存的预算快照</summary>${snapshot}</details>` : ''}
      ${editor}${saved ? muted('保存前的试算使用当前考试与比例。概览继续使用已保存的快照。') : ''}`));
  const exams = `<section class="study-card" id="study-exams" tabindex="-1"><h2>考试管理</h2>
    <p><strong data-stage-name>${phaseNames[stage.phase]}</strong> · <span data-stage-reason>${e(stage.reason)}</span></p>
    ${actions(button('阶段设置', 'settings'))}
    <details ${options.exam ? 'open' : ''} id="study-exam-editor"><summary>${options.exam ? '编辑考试' : '添加考试'}</summary>${examForm(data, now, options.exam)}</details>
    <h3>待考</h3>${active.length ? list(active.map(exam => examEntry(data, exam, false))) : muted('暂无待考事项。')}
    <details data-keep="ended-exams"><summary>已结束及已取消（${ended.length}）</summary>${ended.length ? list(ended.map(exam => examEntry(data, exam, true))) : muted('暂无历史考试。')}</details></section>`;
  return columns(planCard, exams + card('该周实际投入', projectProgress(actual, saved && targetsOf(saved))), 'study-overview');
}

function subjectFields(data: StudyData, subject?: Subject) {
  const track = subject?.track ?? 'school';
  return fields(select('学习类别', 'track', options(trackNames, track)),
    select('科目或项目', 'subjectId', subjectOptions(data, track, subject?.id), true));
}

export function sessionForm(data: StudyData, now: LocalTime, session?: Session, timerMinutes?: number) {
  const timer = data.timer;
  const finish = timerMinutes !== undefined;
  const chosen = data.subjects.find(subject => subject.id === (finish ? timer?.subjectId : session?.subjectId));
  const date = session?.day ?? (finish ? timer?.day : undefined) ?? now.day;
  return form(finish ? 'finish-timer' : 'session', `
    ${finish && timerMinutes >= 240 ? '<div class="study-callout caution">这次计时已达 4 小时。请核对时长，把离开、休息与等待的时间扣除后再保存。</div>' : ''}
    ${finish ? `<p>${e(chosen?.name ?? '')} · 默认按开始日期记入，日期和时长都可以修改。</p>` : subjectFields(data, chosen)}
    ${fields(dateInput('学习日期', 'day', date > now.day ? now.day : date, now.day),
      numberInput('实际时长（分钟）', 'minutes', session?.minutes ?? timerMinutes ?? 30, 1, 1440))}
    ${!finish ? actions(...[15, 30, 45, 60, 90, 120].map(minutes => button(`${minutes} 分`, 'quick-minute', '', String(minutes)))) : ''}
    <details ${session?.quality || session?.note ? 'open' : ''}><summary>质量与成果（可选）</summary>
      ${select('质量或进展', 'quality', qualityOptions(chosen?.track ?? 'school', session?.quality))}
      ${textarea('成果或备注', 'note', session?.note)}</details>
    ${actions(submit(finish ? '保存计时记录' : session ? '保存修改' : '保存学习记录'),
      ...(session || finish ? [button(finish ? '返回计时' : '取消编辑', finish ? 'close-dialog' : 'record')] : []))}
  `, finish ? timer?.id : session?.id);
}

export function timerText(data: StudyData, now: number) {
  if (!data.timer) return '00:00:00';
  const seconds = Math.floor(timerMs(data.timer, now) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

export type RecordFilters = { track: string; subject: string; week: string; page: number };

function sessionEntries(data: StudyData, sessions: Session[]) {
  return list(sessions.map(session => {
    const subject = data.subjects.find(subject => subject.id === session.subjectId)!;
    return `<strong>${e(subject.name)}${subject.archived ? ' <small>已归档</small>' : ''}</strong> · ${duration(session.minutes)}
      <div class="study-muted">${session.day} · ${trackName(subject.track)}${session.quality ? ' · ' + e(session.quality) : ''}</div>
      ${session.note ? `<p>${e(session.note)}</p>` : ''}
      ${actions(button('编辑', 'edit-session', '', session.id), button('删除', 'delete-session', 'danger', session.id))}`;
  }));
}

function history(data: StudyData, now: LocalTime, filter: RecordFilters) {
  const current = monday(now.day);
  const weeks = recordedWeeks(data, current);
  const sessions = [...data.sessions].reverse().sort((a, b) => b.day.localeCompare(a.day)).filter(session => {
    const subject = data.subjects.find(subject => subject.id === session.subjectId);
    return (!filter.week || monday(session.day) === filter.week) &&
      (!filter.track || subject?.track === filter.track) && (!filter.subject || subject?.id === filter.subject);
  });
  const size = 12;
  const maxPage = Math.max(0, Math.ceil(sessions.length / size) - 1);
  const page = Math.min(filter.page, maxPage);
  const weekOptions = weeks.map(week => option(week, weekLabel(week), filter.week)).join('');
  const subjectFilter = data.subjects.filter(subject => !filter.track || subject.track === filter.track);
  const filters = form('filter', fields(
    select('学习周', 'week', option('', '所有周', filter.week) + weekOptions),
    select('类别', 'track', option('', '全部类别', filter.track) + options(trackNames, filter.track)),
    select('科目或项目', 'subject', option('', '全部科目与项目', filter.subject) + subjectFilter.map(subject =>
      option(subject.id, subject.name + (subject.archived ? '（已归档）' : ''), filter.subject)).join('')),
  ));
  const paging = maxPage ? actions(
    ...(page > 0 ? [button('上一页', 'record-page', '', String(page - 1))] : []),
    `<small>第 ${page + 1} / ${maxPage + 1} 页</small>`,
    ...(page < maxPage ? [button('下一页', 'record-page', '', String(page + 1))] : [])) : '';
  return card('历史记录', filters + (sessions.length ?
    sessionEntries(data, sessions.slice(page * size, (page + 1) * size)) + paging
    : muted(data.sessions.length ? '没有符合筛选条件的记录。' : '暂无记录。')));
}

function statistics(data: StudyData, now: LocalTime, selectedWeek: string) {
  const current = monday(now.day);
  const rows = Array.from({ length: 8 }, (_, index) => shiftDay(current, -7 * index)).map(week => {
    const stats = summarize(data, weekSessions(data, week));
    return { week, stats, plan: data.plans.find(plan => plan.week === week) };
  });
  const fullest = Math.max(1, ...rows.map(row => row.stats.total));
  const trend = list(rows.map(({ week, stats, plan }) => `<div class="study-between"><small>${week}</small>
    <strong>${duration(stats.total)}${plan ? ' / ' + duration(plan.budget.allocatable) : ''}</strong></div>
    <div class="study-trend" aria-hidden="true">${tracks.map((track, index) =>
      `<span data-track="${track}" style="width:${stats.actual[index] * 100 / fullest}%"></span>`).join('')}</div>
    <small>${tracks.map((track, index) => `${trackName(track)} ${duration(stats.actual[index])}`).join(' · ')}</small>`));
  const stats = summarize(data, selectedWeek ? weekSessions(data, selectedWeek) : data.sessions);
  const plan = data.plans.find(plan => plan.week === selectedWeek);
  const hasTrend = rows.some(row => row.stats.total || row.plan);
  return `<section class="study-card" id="study-statistics" tabindex="-1"><h2>统计与成果</h2>
    <h3>近八周投入</h3>${hasTrend ? `${muted('实际 / 可分配目标。色条按周展示三类投入。')}${trend}` : muted('暂无周统计。')}
    ${selectedWeek ? `<h3>${weekLabel(selectedWeek)}</h3>${projectProgress(stats.actual, plan && targetsOf(plan))}` : ''}
    <h3>${selectedWeek ? '该周科目与项目' : '累计科目与项目'}</h3>
    ${stats.subjects.length ? list(stats.subjects.map(subject =>
      `<div class="study-between"><span>${e(subject.name)} · ${trackName(subject.track)}</span><strong>${duration(subject.minutes)}</strong></div>`)) : muted('暂无投入记录。')}
    <h3>质量与进展分布</h3>
    ${stats.byQuality.size ? list([...stats.byQuality].map(([quality, count]) => `${e(quality)} · ${count} 次`)) : muted('暂无质量或进展标记。')}
    <details><summary>成果与备注（${stats.sessions.filter(session => session.note).length}）</summary>
      ${outcomes(data, stats.sessions, stats.sessions.length)}</details></section>`;
}

export function recordsView(data: StudyData, now: LocalTime, filter: RecordFilters, editing?: Session) {
  const timer = data.timer;
  const timerCard = `<section class="study-card" id="study-timer" tabindex="-1"><h2>正向计时器</h2>
    <span class="study-time" id="study-timer-clock">${timerText(data, Date.now())}</span>
    ${timer ? `<p>${e(subjectName(data, timer.subjectId))} · ${timer.runningSince === null ? '已暂停' : '进行中'}</p>
      <p class="study-callout caution" id="study-timer-long" ${timerMs(timer, Date.now()) < 14_400_000 ? 'hidden' : ''}>计时已达 4 小时，保存前请核对实际投入。</p>
      ${actions(button(timer.runningSince === null ? '继续' : '暂停', timer.runningSince === null ? 'resume-timer' : 'pause-timer', '', timer.id),
        button('结束并保存', 'finish', 'primary', timer.id), button('放弃', 'discard-timer', 'danger', timer.id))}`
    : form('timer', subjectFields(data) + actions(submit('开始计时')))}
    ${muted('休息、上课与等待 AI 时可以暂停。计时状态会保存在此设备。')}</section>`;
  const quick = `<section class="study-card" id="study-record" tabindex="-1"><h2>${editing ? '编辑学习记录' : '快速补录'}</h2>
    ${sessionForm(data, now, editing)}</section>`;
  const week = monday(now.day);
  return columns(timerCard + quick + history(data, now, filter),
    card('每周复盘', `<p>${weekLabel(filter.week || week)}</p>${actions(button('打开周复盘', 'review', '', filter.week || week))}`) +
    statistics(data, now, filter.week), 'study-overview');
}

export function reviewView(data: StudyData, now: LocalTime, week: string) {
  const review = data.reviews.find(item => item.week === week);
  const plan = data.plans.find(plan => plan.week === week);
  const sessions = weekSessions(data, week);
  const stats = summarize(data, sessions);
  const next = shiftDay(week, 7);
  const nextPlan = data.plans.find(plan => plan.week === next);
  const previewBudget = nextPlan?.budget ?? calculateBudget(next, plan?.minutes ?? Array(7).fill(0), Array(7).fill(null), data.exams, data.settings);
  const nextPhases = [...new Set(previewBudget.days.flatMap(day => day.parts.map(part => phaseNames[part.phase])))];
  const urgent = upcomingImportant(data, now);
  const prompts: [keyof Omit<Review, 'week'>, string][] = [
    ['balance', '三类投入是否平衡？'], ['knowledge', '能够独立应用的知识'],
    ['results', '完成的项目成果'], ['issues', '尚未解决的问题'], ['nextFocus', '下周重点学习目标'],
  ];
  const independent = sessions.filter(session => session.quality === '能够独立应用');
  const projects = sessions.filter(session => data.subjects.find(subject => subject.id === session.subjectId)?.track === 'project');
  return columns(card('每周复盘', `<p>${weekLabel(week)}</p>${projectProgress(stats.actual, plan && targetsOf(plan))}
    <details><summary>独立应用与项目成果</summary>
      <h3>独立应用</h3>${outcomes(data, independent, independent.length)}
      <h3>项目成果</h3>${outcomes(data, projects, projects.length)}</details>
    ${form('review', prompts.map(([key, label]) => textarea(label, key, review?.[key])).join('') +
      actions(submit('保存复盘'), ...(next >= monday(now.day) ? [button(nextPlan ? '打开下周计划' : '建立下周计划', 'next-week', '', week)] : [])), week)}`),
    card('下周安排', `<p>${weekLabel(next)}</p><p>${nextPhases.join(' · ')}</p>
      ${muted(nextPlan ? '已保存计划' : plan ? '按本周可用时间试算，建立计划后可调整。' : '下周尚无可用时间安排。')}
      ${budgetPreview(previewBudget, nextPlan?.manual)}`) +
    card('未来 28 天的重要考试', urgent.length ? list(urgent.map(exam =>
      `<strong>${e(exam.name)}</strong> · ${countdown(now, exam)}<br><small>${e(exam.day)} · ${masteryNames[exam.mastery]}</small>`))
      : muted('暂无重要考试。')), 'study-overview');
}

function subjectEntry(subject: Subject, index: number, count: number) {
  return form('subject', textInput('名称', 'name', subject.name, true) +
    actions(submit('保存名称'), ...(index > 0 ? [button('上移', 'move-up', '', subject.id)] : []),
      ...(index < count - 1 ? [button('下移', 'move-down', '', subject.id)] : []),
      button(subject.archived ? '取消归档' : '归档', 'archive', '', subject.id)), subject.id);
}

export function settingsView(data: StudyData) {
  const settings = data.settings;
  const ratioInputs = phases.map(phase => `<fieldset><legend>${phaseNames[phase]}</legend><div class="study-ratios">
    ${tracks.map((track, index) => numberInput(trackNames[track] + '（%）', `ratio-${phase}-${index}`, settings.ratios[phase][index], 0, 100)).join('')}
    </div></fieldset>`).join('');
  const subjectGroup = tracks.map(track => {
    const subjects = data.subjects.filter(subject => subject.track === track);
    return `<details data-keep="subjects-${track}"><summary>${trackName(track)}（${subjects.filter(subject => !subject.archived).length} 项）</summary>
      ${subjects.length ? list(subjects.map((subject, index) => `${subject.archived ? '<small>已归档</small>' : ''}
        ${subjectEntry(subject, index, subjects.length)}`)) : ''}
      ${form('subject-add', textInput('新科目或项目', 'name', '', true) + actions(submit('添加')), track)}</details>`;
  }).join('');
  const timing = card('阶段与预算设置', form('settings', fields(
    input('时区（IANA）', 'timezone', settings.timezone, 'type="text" list="study-timezones" maxlength="100" required'),
    select('阶段判定', 'override', options({ auto: '自动推荐', ...phaseNames }, settings.override)),
    numberInput('机动时间（%）', 'buffer', settings.buffer, 0, 100),
    select('无结束时间的考试', 'untimedExam', options({ endOfDay: '当天结束', midday: '当天 12:00', startOfDay: '当天开始' }, settings.untimedExam)),
  ) + `<datalist id="study-timezones"><option value="Asia/Shanghai"><option value="Asia/Tokyo"><option value="Europe/London"><option value="America/New_York"></datalist>
    <label class="study-check"><input type="checkbox" name="vacation"${settings.vacation ? ' checked' : ''}>开启寒暑假模式</label>` +
    muted('如只录入考试开始时间，阶段至少持续到开始后 1 分钟。每个阶段的三类比例合计须为 100%。') +
    ratioInputs + actions(submit('保存设置'), button('恢复默认比例与机动时间', 'reset-ratios'))));
  const backups = card('本地数据与备份', `<p>数据保存在此设备上当前浏览器的 IndexedDB。不同设备、浏览器及主屏幕应用可能各有一份数据。删除网页 App 或清理网站数据可能丢失记录。</p>
    <p>可定期导出完整 JSON 至 iCloud Drive。恢复备份会替换当前设备的数据，包括进行中的计时。文件只在本机读取。</p>
    ${actions(button('导出 JSON', 'export', 'primary'), button('选择备份恢复', 'import'))}
    <input type="file" id="study-backup-file" aria-label="选择备份文件" accept=".json,application/json" hidden>
    <details><summary>添加到 iPhone 主屏幕</summary><p>在 Safari 打开学习工作台，点分享，再选择「添加到主屏幕」。若看到「作为网页 App 打开」，开启后再添加。从主屏幕图标打开后保持在线，等待离线准备完成。</p></details>`);
  return columns(timing, backups + card('科目与项目管理', muted('归档会从新记录的选项中隐藏，历史记录继续保留。') + subjectGroup), 'study-overview');
}
