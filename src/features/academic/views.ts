import { escape as e, options, subjectName } from '../study/views.ts';
import { duration, localClock, monday, shiftDay } from '../study/time.ts';
import { apportion, baselineAt, recentExam, recommend, scheduleOf, stageAt, stageNames, weeklyAllocation } from './allocation.ts';
import { blankCourse, inTerm, inputsOf, outsideId, reserveId,
  type Course, type DeskData, type Material, type Result, type Route, type Term, type Vector } from './model.ts';
import { normalized, propose, reviewOf, targetAt } from './review.ts';

const modes = { ability: '能力积累', bank: '题库应试', task: '任务完成' };
const states = { unassessed: '未摸底', normal: '正常', strengthen: '重点补强', achieved: '阶段目标达成', completed: '考核完成' };
const statuses = { scheduled: '待处理', completed: '已完成', cancelled: '已取消' };
const uses = { unused: '未使用', practice: '专项训练', sealed: '封存', mocked: '已模拟' };
const conditions = { unknown: '未知', independent: '独立', materials: '允许资料', assisted: '受提示或 AI 辅助' };
const attempts = { unknown: '未知', first: '首次', repeat: '重做' };
const metrics = { score: '得分', independent: '独立练习', count: '正确数', coverage: '覆盖进度', done: '完成', official: '正式成绩归档' };
export const resultTags = ['公式提取', '运算化简', '题型识别', '借助提示', '粗心', '时间不足', '程序追踪', '题库记忆'];

const html = String.raw;
const card = (title: string, body: string) => html`<section class="study-card"><h2>${e(title)}</h2>${body}</section>`;
const panel = (title: string, body: string, id: string, open = false) =>
  html`<details data-keep="${e(id)}" ${open ? 'open' : ''}><summary>${e(title)}</summary>${body}</details>`;
const button = (title: string, action: string, id = '') =>
  html`<button class="study-action" type="button" data-action="${e(action)}" data-id="${e(id)}">${e(title)}</button>`;
const submit = (title = '保存') => html`<button class="study-action primary" type="submit">${e(title)}</button>`;
const form = (action: string, id: string, body: string, submitText?: string) =>
  html`<form data-form="${e(action)}" data-id="${e(id)}">${body}<div class="study-actions">${submit(submitText)}</div></form>`;
const input = (name: string, label: string, value: string | number = '', attrs = 'maxlength="120"') =>
  html`<label>${e(label)}<input name="${e(name)}" value="${e(value)}" ${attrs}></label>`;
const select = (name: string, label: string, values: Record<string, string>, value = '') =>
  html`<label>${e(label)}<select name="${e(name)}">${options(values, value)}</select></label>`;
const check = (name: string, label: string, on: boolean) =>
  html`<label><input type="checkbox" name="${e(name)}" ${on ? 'checked' : ''}> ${e(label)}</label>`;
const dates = (from = '', through = '', required = false) => input('from', '开始日', from, 'type="date"' + (required ? ' required' : '')) +
  input('through', '结束日（含）', through, 'type="date"' + (required ? ' required' : ''));
const percent = (ratio: number | null | undefined) => ratio == null ? '—' : `${Math.round(ratio * 100)}%`;
const toPercent = (ratio: number | null) => ratio === null ? '' : +(ratio * 100).toFixed(8);
const dateInput = (name: string, label: string, value = '') => input(name, label, value, 'type="date"');
const number = (name: string, label: string, value: number | string = '', min = 0, max = 100) =>
  input(name, label, value, `type="number" min="${min}" max="${max}" step="any"`);
const grid = (body: string) => html`<div class="academic-grid">${body}</div>`;
const list = (items: string[]) => items.length ? html`<ul class="academic-list">${items.map(item => `<li>${item}</li>`).join('')}</ul>` : '<p>暂无记录。</p>';
const schoolOptions = (data: DeskData) => Object.fromEntries(data.subjects.filter(item => item.track === 'school')
  .map(item => [item.id, item.name + (item.archived ? '（归档）' : '')]));
const subjectLabel = (data: DeskData, id: string) => id === reserveId ? subjectName(data, data.academic.otherId) + ' · 机动' :
  id === outsideId ? '学期范围外' : subjectName(data, id);
const subject = (data: DeskData, value = '') => select('subjectId', '课程', schoolOptions(data), value);

function courseProgress(data: DeskData, minutes: Vector, target: Vector, total: number, budget: number | null) {
  const actual = total ? apportion(Object.fromEntries(Object.entries(minutes).map(([id, value]) => [id, value / total])), 100) : {};
  const planned = apportion(target, 100);
  const budgetMinutes = budget !== null ? apportion(target, budget) : {};
  const ids = [...new Set([...Object.keys(target), ...Object.keys(minutes).map(id => id === data.academic.otherId ? reserveId : id)])];
  if (!ids.length) return '<p>暂无课内记录和有效分配。</p>';
  return '<ul class="academic-progress">' + ids.map(id => {
    const actualId = id === reserveId ? data.academic.otherId : id;
    const name = e(subjectLabel(data, id));
    const done = minutes[actualId] ?? 0;
    const plan = budgetMinutes[id];
    const color = [...id].reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 0) % 3;
    const completion = plan > 0 ? ' · 完成 ' + percent(done / plan) : '';
    const over = plan !== undefined && done > plan ? ' · 超出 ' + duration(done - plan) : '';
    const meter = plan > 0 || (plan === 0 && done > 0) ?
      `<meter aria-label="${name}计划完成进度" min="0" max="${plan || 1}" value="${plan ? Math.min(done, plan) : 1}"></meter>` : '';
    return `<li class="study-progress" data-track="${['school', 'self', 'project'][color]}">
      <div class="study-between"><span class="study-track-name">${name}</span><strong>${duration(done)} / ${plan === undefined ? '未设计划' : duration(plan)}</strong></div>
      ${meter}<small>实际占比 ${total ? (actual[actualId] ?? 0) + '%' : '—'} · 目标占比 ${Object.hasOwn(planned, id) ? planned[id] + '%' : '—'}${completion}${over}</small>
    </li>`;
  }).join('') + '</ul>';
}

export function home(data: DeskData, term: Term, now: number) {
  const clock = localClock(now, data.settings.timezone);
  const inputs = inputsOf(data);
  const { stage, route } = stageAt(inputs, term, clock);
  const target = targetAt(data, term, now);
  const summary = weeklyAllocation(data, term, monday(clock.day), clock, target);
  const next = recommend(data, term, clock, target);
  const exam = recentExam(data, term, clock);
  const urgent = next?.code === 'deadline' ? scheduleOf(inputs, term).find(row => row.id === next.evidenceId) : undefined;
  const focus = data.academic.next?.termId === term.id && data.academic.next.day === clock.day ? data.academic.next : null;
  const choices = Object.fromEntries(baselineAt(inputs, term, clock, data.academic.otherId).courses
    .filter(item => item.eligible).map(({ course }) => [course.subjectId, subjectName(data, course.subjectId)]));
  return card('下一步', next ? `<h3>${e(subjectLabel(data, next.subjectId))} · ${e(next.action)}</h3>
    ${next.minutes ? '<p>建议 ' + next.minutes + ' 分钟</p>' : ''}
    ${panel('建议详情', '<p>' + e(next.reason) + '</p>', 'next-reason')}` :
    `<p>${focus?.defer ? '今日已暂缓常规建议。' : stage === 'vacation' ? '休息中，当前没有急项。' : '当前没有需要优先安排的课程。'}</p>`) +
  card(urgent ? '急项' : '最近考核', `<p>${urgent ? e(urgent.title) + ' · ' + e(urgent.day) :
    exam ? e(exam.title) + ' · ' + (exam.distance ? exam.distance + ' 天后' : '今天') : '暂无已确定的待考事项'}
    ${term.examWeek ? ' · 预计考试周 ' + e(term.examWeek) : ''}</p>
    <a class="study-action" href="/desk/study/#study-exams">查看考试与任务</a>`) +
  card('本周分配', `<div class="academic-meta"><p>${e(term.name)}</p><p>${stageNames[stage]}${route?.label ? ' · ' + e(route.label) : ''}</p></div>
    <p class="academic-metric" data-academic-total>${duration(summary.total)}</p>
    <p>本周课内投入${summary.budget === null ? ' · Study 尚无周预算' : ' · A 轨计划 ' + duration(summary.budget) +
      (summary.rate === null ? '' : ' · 完成 ' + percent(summary.rate)) + ' · 余量 ' + duration(summary.remaining!)}${summary.budget !== null && summary.total > summary.budget ? ' · 已超计划' : ''}</p>` +
    courseProgress(data, summary.minutes, target, summary.total, summary.budget) +
    (summary.crowded && stage !== 'vacation' ? '<p>其他及暂不参与分配的课次占用较多。</p>' : '') +
    (!term.courses.length ? '<button class="study-action" type="button" data-view="courses">配置课程</button>' : '')) +
  (Object.keys(choices).length ? card('今日重点', panel('调整今日重点', '<form data-form="next" data-id="' + e(term.id) + '">' +
    select('choice', '今日重点', { auto: '恢复自动建议', defer: '今天暂缓', change: '换一门课' }, focus?.defer ? 'defer' : focus ? 'change' : 'auto') +
    '<div data-focus-course>' + select('subjectId', '课程', { '': '请选择', ...choices }, focus?.subjectId) + '</div></form>', 'next')) : '');
}

function courseForm(data: DeskData, course: Course) {
  const subjectRow = data.subjects.find(item => item.id === course.subjectId)!;
  return form('course', course.subjectId, grid(input('name', '共享科目名', subjectRow.name, 'maxlength="120" required') +
    select('mode', '课程模式', modes, course.mode) + select('status', '状态', states, course.status) +
    select('activation', '参与分配', { auto: '按日期和模式', on: '已激活', off: '待激活' }, course.activation) +
    dates(course.from, course.through) + check('disabled', '本学期停用', course.disabled) + check('archived', '归档共享科目', subjectRow.archived)) +
    panel('分配和目标参数', grid(number('credits', '学分', course.credits ?? '', .000001, 10000) +
      number('finalShare', '期末占比（%）', toPercent(course.finalShare)) +
      number('cost', '个人成本', course.cost ?? '', .25, 2) + number('goal', '阶段目标（%）', toPercent(course.goal)) +
      number('coverageGoal', '题库覆盖目标（%）', toPercent(course.coverageGoal))),
    'params-' + course.subjectId) + '<p>现有课次、考试和活动计时会继续引用该科目。</p>');
}

function materialForm(item: Partial<Material> = {}) {
  return grid(input('title', '年份或名称', item.title, 'maxlength="120" required') +
    input('location', '位置提示', item.location, 'maxlength="2000"') +
    select('use', '用途', uses, item.use ?? 'unused'));
}

export function courses(data: DeskData, term: Term, now: number) {
  const clock = localClock(now, data.settings.timezone);
  const model = baselineAt(inputsOf(data), term, clock, data.academic.otherId);
  const stats = weeklyAllocation(data, term, monday(clock.day), clock, model.target);
  return card('课程管理', '<button class="study-action" data-view="settings" type="button">返回设置</button>' + data.subjects.filter(item => item.track === 'school').map(item => {
    const config = model.courses.find(entry => entry.course.subjectId === item.id);
    const course = config?.course ?? blankCourse(item.id);
    const recent = data.academic.results.filter(result => result.termId === term.id && result.subjectId === item.id)
      .sort((a, b) => b.day.localeCompare(a.day) || b.at - a.at);
    const index = data.academic.materials.filter(row => row.termId === term.id && row.subjectId === item.id);
    const status = item.archived ? '归档' : course.disabled ? '停用' : config?.done ? '考核完成' : config?.stale ? '考试待更新' :
      config?.exam && config.due <= 3 ? '临近考试' : config?.active ? states[course.status] : config ? '暂不分配' : '待配置';
    const aliases = [...new Set(data.academic.aliases.filter(alias => alias.subjectId === item.id).map(alias => alias.name))];
    return panel(item.name + ' · ' + status,
      (course.strategy || course.focus || course.focus2 ? panel('旧课程策略与重点', list([course.strategy, course.focus, course.focus2].filter(Boolean).map(e)), 'legacy-course-' + item.id) : '') +
      (aliases.length ? '<p>历史名称 · ' + e(aliases.join('、')) + '</p>' : '') +
      (stats.days.get(item.id)?.size === 1 && stats.minutes[item.id] >= 90 ? '<p>本周投入集中在一天，可分散下一次训练。</p>' : '') +
      courseForm(data, course) +
      panel('考核及成果', list((config?.items ?? []).map(row => e(row.title) + ' · ' + statuses[row.status])) +
        (config?.course.checklist?.length ? '<p>已确认必需清单。</p>' :
          button('确认必需清单完整', 'checklist', item.id)) +
        list(recent.slice(0, 5).map(resultLabel)) + button('录入此课成果', 'result-course', item.id), 'progress-' + item.id) +
      panel('资料索引', (index.length === 6 || index.length === 7 ?
        '<p>可留一套摸底、' + (index.length - 3) + ' 套专项、两套封存。优先考虑封存最近两套。</p>' : '') +
        index.map(row => panel(row.title + ' · ' + uses[row.use],
          (row.note ? '<p>' + e(row.note) + '</p>' : '') + form('material', row.id, materialForm(row)) + button('删除索引', 'delete-material', row.id), 'material-' + row.id)).join('') +
        panel('添加资料', form('material-add', item.id, materialForm()), 'material-new-' + item.id), 'materials-' + item.id),
      'course-' + item.id);
  }).join('') + panel('新增共享科目', form('subject-add', '', input('name', '课程名称', '', 'maxlength="120" required')), 'subject-new'));
}

const routeForm = (route: Partial<Route> = {}) => grid(dates(route.from, route.through, true) +
  select('stage', '训练阶段', stageNames, route.stage ?? 'normal'));

function studyRoute(term: Term) {
  return panel('复习路线', form('stage', term.id, grid(select('override', '手动阶段', { '': '随日期与 Study', ...stageNames }, term.override) +
    dateInput('examWeek', '预计考试周（周一）', term.examWeek))) +
    term.routes.map(route => panel(route.label || stageNames[route.stage], (route.focus ? '<p>' + e(route.focus) + '</p>' : '') +
      form('route', route.id, routeForm(route)) + button('移除区间', 'delete-route', route.id), 'route-' + route.id)).join('') +
    panel('新增阶段或休息区间', form('route', '', routeForm()), 'new-route'), 'study-route');
}

export function resultActivities(data: DeskData, term: Term, id: string) {
  const mode = term.courses.find(course => course.subjectId === id)?.mode;
  const name = subjectName(data, id);
  let labels = ['章节练习', '独立练习', '错题复测', '历年卷'];
  if (mode === 'bank') labels = ['题库练习', '题库覆盖', '复测', '模拟'];
  else if (mode === 'task') labels = ['作业', '资料准备', '考核完成'];
  else if (/英语/.test(name)) labels = ['阅读', '听力', '词汇', '翻译', '写作', '历年卷'];
  else if (/程序|^C\s*语言/.test(name)) labels = ['程序阅读', '知识点练习', '独立练习', '历年卷'];
  return labels;
}

export function resultChoices(data: DeskData, term: Term, subjectId: string) {
  const old = data.academic.results.filter(row => row.subjectId === subjectId);
  return {
    activities: [...new Set([...resultActivities(data, term, subjectId), ...old.map(row => row.activity)])],
    scopes: [...new Set(['整卷', '全题库', ...Array.from({ length: 20 }, (_, index) => '第' + (index + 1) + '章'),
      ...data.academic.materials.filter(row => row.subjectId === subjectId).map(row => row.title),
      ...old.map(row => row.scope).filter(Boolean)])],
    difficulties: { foundation: '基础', standard: '标准', advanced: '进阶',
      ...Object.fromEntries(old.map(row => row.difficulty).filter(key => key && !['foundation', 'standard', 'advanced'].includes(key)).map(key => [key, key])) },
  };
}

export function defaultMetric(activity: string, term: Term, subjectId: string): Result['metric'] {
  if (activity === '独立练习') return 'independent';
  if (activity === '题库覆盖') return 'coverage';
  if (term.courses.find(course => course.subjectId === subjectId)?.mode === 'task') return 'done';
  return 'score';
}

const resultLabel = (item: Result) => e(item.activity) + ' · ' + e(item.day) + ' · ' +
  (item.metric === 'done' ? '已完成' : e(item.value!) + '/' + e(item.total!) + '（' + percent(normalized(item)) + '）') +
  (item.prompted === null ? '' : ' · 提示后正确 ' + percent(item.prompted / item.total!));

export function results(data: DeskData, term: Term, today: string, prefill: string, entry: string) {
  const item = data.academic.results.find(row => row.id === entry && row.termId === term.id);
  const id = item?.subjectId || prefill || term.courses[0]?.subjectId || data.academic.otherId;
  const recent = data.academic.results.findLast(row => row.termId === term.id && row.subjectId === id);
  const sessionOptions = Object.fromEntries(data.sessions.filter(session => inTerm(session.day, term) &&
      session.day <= today && data.subjects.some(course => course.id === session.subjectId && course.track === 'school'))
    .sort((a, b) => b.day.localeCompare(a.day)).map(session =>
      [session.id, session.day + ' · ' + subjectName(data, session.subjectId) + ' · ' + session.minutes + ' 分']));
  const activity = item?.activity ?? recent?.activity ?? resultActivities(data, term, id)[0];
  const metric = item?.metric ?? (recent?.activity === activity ? recent.metric : defaultMetric(activity, term, id));
  const choices = resultChoices(data, term, id);
  const toOptions = (items: string[]) => Object.fromEntries(items.map(label => [label, label]));
  return card(item ? '编辑成果' : '录入成果',
    form('result', item?.id ?? '', grid(subject(data, id) + select('activity', '活动', toOptions(choices.activities), activity)) +
      '<div class="academic-grid" data-metric-values>' +
      number('value', '实得', item?.value ?? '', 0, 100000) + number('total', '满分或总量', item?.total ?? (metric === 'score' || metric === 'official' ? 100 : ''), 0, 100000) +
      '<div data-prompted>' + number('prompted', '提示后正确（选填）', item?.prompted ?? '', 0, 100000) + '</div></div>' +
      '<p class="study-muted">只填结果也能保存；补齐可比条件后，才可能参与周报趋势和分配建议。</p>' +
      panel('可比条件与错因', grid(select('scope', '范围或题库', { '': '未分组', ...toOptions(choices.scopes) }, item?.scope) +
        select('difficulty', '难度', { '': '未分组', ...choices.difficulties }, item?.difficulty) +
        select('condition', '作答条件', conditions, item?.condition ?? 'unknown') + select('attempt', '是否见过', attempts, item?.attempt ?? 'unknown')) +
        grid(resultTags.map(tag => check('tag-' + tag, tag, item?.tags.includes(tag) ?? false)).join('')), 'result-detail') +
      panel('日期、结果类型与课次', grid(select('metric', '结果类型', metrics, metric) + dateInput('day', '日期', item?.day ?? today) +
        select('sessionId', '关联已保存课次', { '': '不关联', ...sessionOptions }, item?.sessionId)), 'result-options')) +
    (item ? button('返回新增成果', 'result-course', id) : '')) +
    card('成果历史', list(data.academic.results.filter(row => row.termId === term.id).sort((a, b) => b.day.localeCompare(a.day) || b.at - a.at)
      .map(row => '<strong>' + e(subjectLabel(data, row.subjectId)) + '</strong> · ' + resultLabel(row) + (row.note ? '<p>' + e(row.note) + '</p>' : '') +
        '<div class="study-actions">' + button('编辑', 'edit-result', row.id) + button('删除', 'delete-result', row.id) + '</div>')));
}

export function review(data: DeskData, term: Term, week: string, now: number, close: boolean) {
  const report = reviewOf(data, term, week, now, close);
  const adjust = data.academic.adjustments.filter(item => item.proposal.termId === term.id &&
    (item.proposal.week === week || item.proposal.inputWeek === week));
  const suggestion = propose(data, term, now, close);
  const preview = suggestion && !data.academic.adjustments.some(item => item.proposal.termId === term.id &&
    item.proposal.week === suggestion.week && (item.state === 'pending' || item.appliedAt !== null)) ? suggestion : undefined;
  const vector = (p: NonNullable<typeof suggestion>) => list(Object.keys(p.before).map(id =>
    e(subjectLabel(data, id)) + ' · ' + (p.before[id] * 100).toFixed(2) + '% → ' + (p.after[id] * 100).toFixed(2) + '%'));
  const evidence = (p: NonNullable<typeof suggestion>) => '<p>' + e(subjectLabel(data, p.evidence.subjectId)) + ' · 规则 v' + p.rule +
    ' · 投入周 ' + e(p.inputWeek) + ' · ' + p.evidence.minutes + ' 分钟 / ' +
    (p.evidence.planned === null ? '计划未知' : Math.round(p.evidence.planned) + ' 分钟') + ' · 目标 ' + percent(p.evidence.goal) +
    (p.evidence.gaps ? ' · 当时缺口 ' + p.evidence.gaps.map(Math.round).join(' / ') + ' 分钟' : '') + '</p>' +
    list(p.evidence.pair.map(item => e(item.day) + ' · ' + e(item.activity) + ' · ' + e(item.scope) + ' · ' +
      e(item.difficulty) + ' · ' + conditions[item.condition] + ' · ' + attempts[item.attempt] + ' · ' +
      e(item.value!) + '/' + e(item.total!))) + vector(p);
  const labels = { pending: '待生效', applied: '已生效', invalid: '需重新确认', paused: '已暂停', rejected: '已拒绝' };
  return {
    preview,
    html: card('学业周报', form('review-week', '', dateInput('week', '查看日期所在周', week), '查看周报') +
      '<p>' + e(week) + ' 至 ' + e(report.through) + ' · ' + (report.complete ? '已完周' : '进行中') + ' · 课内 ' +
      duration(report.total) + ' · ' + new Set(report.records.map(item => item.day)).size + ' 个学习日' +
      (report.budget === null ? ' · A 轨预算未知' : ' · A 轨计划 ' + duration(report.budget) + ' · 完成率 ' + percent(report.rate)) + '</p>' +
      (!report.history ? '<p>缺少稳定或可追溯的目标配置，投入判断证据不足。</p>' : '') +
      courseProgress(data, report.minutes, report.history ?? {}, report.total, report.budget) +
      panel('四周投入与当周活动', list(report.trend.map(item => e(item.week) + ' · ' + (item.minutes === null ? '无记录' : duration(item.minutes)))) +
        list(Object.entries(Object.groupBy(report.results, item => item.activity)).map(([label, group]) => e(label) + ' · ' + group!.length + ' 条')) +
        list(scheduleOf(inputsOf(data), term).filter(row => row.day >= week && row.day <= report.through)
          .map(row => e(row.day) + ' · ' + e(row.title) + ' · ' + statuses[row.status])), 'review-trend') +
      panel('课程观察与下周重点', list(report.courses.map(item => {
        const found = item.comparison;
        return '<strong>' + e(subjectLabel(data, item.course.subjectId)) + '</strong> · ' +
          (report.days.get(item.course.subjectId)?.size ?? 0) + ' 天 · ' + e(item.advice) +
          (found ? '<p>' + e(found.pair[0].activity) + ' · ' + e(found.pair.map(sample => sample.day).join(' 至 ')) +
            ' · ' + found.count + ' 条 · ' + found.trend + ' · ' + found.pair.map(sample => percent(normalized(sample))).join(' → ') + '</p>' : '') +
          (item.feedback.length ? '<p>' + Object.entries(Object.groupBy(item.feedback, value => value))
            .map(([name, group]) => e(name) + ' ' + group!.length + ' 条').join(' · ') + '</p>' : '') +
          (item.hard ? '<p>可回顾学习方法及使用提示的时点。</p>' : '') +
          (item.course.focus || item.course.focus2 ? '<p>' + e([item.course.focus, item.course.focus2].filter(Boolean).join(' · ')) + '</p>' : '');
      })), 'review-courses') +
      (localClock(now, data.settings.timezone).day === shiftDay(week, 6) && !close ?
        button('以今天的数据结束本周预览', 'close-week') : '')) +
      card('分配调整', (preview ? '<h3>目标周 ' + e(preview.week) + '</h3>' + evidence(preview) +
        '<div class="study-actions">' + button('确认应用', 'confirm') + button('拒绝方案', 'reject') + '</div>' :
        '<p>当前没有可确认的效果调整。</p>') +
        adjust.map(item => panel(e(item.proposal.week) + ' · ' + labels[item.state],
          (item.reason ? '<p>' + e(item.reason) + '</p>' : '') +
          (item.appliedAt ? '<p>生效 · ' + e(new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short',
            timeZone: item.proposal.config.settings.timezone }).format(item.appliedAt)) + '</p>' : '') +
          '<p>原确认依据 · 周报按当前保存的记录重算。</p>' + evidence(item.proposal), 'decision-' + item.confirmedAt)).join('')),
  };
}

export function settings(data: DeskData, term: Term | undefined, now: number) {
  const clock = localClock(now, data.settings.timezone);
  const current = data.academic.terms.find(item => item.id === data.academic.currentTerm);
  const unassigned = current ? data.sessions.filter(item => item.subjectId === data.academic.otherId && inTerm(item.day, current)) : [];
  const destinations = Object.fromEntries(data.subjects.filter(item =>
    item.track === 'school' && !item.archived && item.id !== data.academic.otherId).map(item => [item.id, item.name]));
  const active = term && baselineAt(inputsOf(data), term, clock, data.academic.otherId);
  const terms = data.academic.terms.map(item => panel(item.name + (item.archived ? ' · 归档' : ''),
    form('term', item.id, grid(input('name', '名称', item.name, 'required maxlength="120"') + dates(item.from, item.through, true))) +
    '<div class="study-actions">' + (item.archived ? button('恢复学期', 'unarchive-term', item.id) :
      button('设为当前学期', 'current-term', item.id) + button('归档学期', 'archive-term', item.id)) +
    button('查看此学期', 'inspect-term', item.id) + '</div>', 'term-' + item.id)).join('');
  return (term ? card('课程管理', '<button class="study-action" type="button" data-view="courses">打开课程管理</button>' +
    studyRoute(term)) : '') + card('学期', terms + panel('新增学期', form('term', '', grid(input('name', '名称', '', 'required maxlength="120"') + dates('', '', true)),
    '创建学期'), 'new-term', !data.academic.terms.length)) +
    (term && active ? card('分配设置', form('reserve', term.id, number('reserve', '机动（%）', toPercent(term.reserve), 0, 20)) +
      panel('手动比例与恢复自动', Object.keys(active.weights).length ?
        form('manual', term.id, '<p>填写当前有效课的完整比例，含机动合计 100%。</p>' +
          grid(Object.keys(active.weights).filter(id => id !== reserveId).map(id =>
            number(id, subjectLabel(data, id) + '（%）', toPercent(active.target[id])).replace('step="any"', 'step="any" required')).join('')) +
          '<p>机动 ' + percent(term.reserve) + '</p>') : '<p>配置并激活课程后可自定分配。</p>', 'manual') +
      (term.manual ? button('恢复自动权重', 'auto', term.id) : '')) : '') +
    (current && unassigned.length ? card('整理其他课程的旧记录',
      '<p>把之前记在「其他课程」的一条学习记录换到正确科目。学习日期和时长保持原样。</p>' +
      form('map-session', current.id, select('sessionId', '待整理记录', { '': '请选择', ...Object.fromEntries(unassigned.map(item =>
        [item.id, item.day + ' · ' + duration(item.minutes)])) }) +
        select('subjectId', '目标课程', { '': '请选择', ...destinations }) +
        '<p>保存前会确认原科目、新科目、日期和时长。</p>')) : '') +
    card('本地备份', '<p>Study 和 Academic 共用当前站点、同一浏览器存储分区的记录。备份包含隐私数据，可主动转移到另一设备。此浏览器及同源脚本可访问这些数据。</p>' +
      '<div class="study-actions">' + button('导出完整 JSON', 'export') + button('选择备份恢复', 'import') +
      '</div><input type="file" accept=".json,application/json" data-backup-file hidden>');
}
