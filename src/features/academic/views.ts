import { escape as e, options, subjectName } from '../study/views.ts';
import { duration, localClock, monday, shiftDay } from '../study/time.ts';
import { apportion, baselineAt, recentExam, recommend, scheduleOf, stageAt, stageNames, weeklyAllocation } from './allocation.ts';
import { blankCourse, inTerm, inputsOf, outsideId, reserveId,
  type Assessment, type Course, type DeskData, type Material, type Result, type Route, type Term, type Vector } from './model.ts';
import { normalized, propose, reviewOf, targetAt } from './review.ts';

const modes = { ability: '能力积累', bank: '题库应试', task: '任务完成' };
const states = { unassessed: '未摸底', normal: '正常', strengthen: '重点补强', achieved: '阶段目标达成', completed: '考核完成' };
const kinds = { exam: '考试', assignment: '作业', online: '线上学习', oral: '口语', diagnostic: '摸底', preparation: '准备' };
const statuses = { scheduled: '待处理', completed: '已完成', cancelled: '已取消' };
const certainty = { confirmed: '确定', tentative: '暂定', unknown: '未定' };
const uses = { unused: '未使用', practice: '专项训练', sealed: '封存', mocked: '已模拟' };
const conditions = { unknown: '未知', independent: '独立', materials: '允许资料', assisted: '受提示或 AI 辅助' };
const attempts = { unknown: '未知', first: '首次', repeat: '重做' };
const metrics = { score: '得分', independent: '独立练习', count: '正确数', coverage: '覆盖进度', done: '完成', official: '正式成绩归档' };
const tags = ['公式提取', '运算化简', '题型识别', '借助提示', '粗心', '时间不足', '程序追踪', '题库记忆'];

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
const textarea = (name: string, label: string, value = '') =>
  html`<label>${e(label)}<textarea name="${e(name)}" maxlength="2000" rows="2">${e(value)}</textarea></label>`;
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

function table(data: DeskData, minutes: Vector, target: Vector, total: number, budget: number | null) {
  const actual = total ? apportion(Object.fromEntries(Object.entries(minutes).map(([id, value]) => [id, value / total])), 100) : {};
  const planned = apportion(target, 100);
  const budgetMinutes = budget !== null ? apportion(target, budget) : {};
  const ids = [...new Set([...Object.keys(target), ...Object.keys(minutes).map(id => id === data.academic.otherId ? reserveId : id)])];
  if (!ids.length) return '<p>暂无课内记录和有效分配。配置课程后即可查看目标。</p>';
  return html`<table class="academic-table"><thead><tr><th scope="col">课程</th><th scope="col">实际</th>
    <th scope="col">实际占比</th><th scope="col">目标</th>${budget !== null ? '<th scope="col">计划</th>' : ''}
    </tr></thead><tbody>${ids.map(id => {
      const actualId = id === reserveId ? data.academic.otherId : id;
      return `<tr><th scope="row">${e(subjectLabel(data, id))}</th><td>${minutes[actualId] ?? 0} 分</td>
        <td>${total ? (actual[actualId] ?? 0) + '%' : '—'}</td><td>${Object.hasOwn(planned, id) ? planned[id] + '%' : '—'}</td>
        ${budget !== null ? '<td>' + (Object.hasOwn(budgetMinutes, id) ? budgetMinutes[id] + ' 分' : '—') + '</td>' : ''}</tr>`;
    }).join('')}</tbody></table>`;
}

export function home(data: DeskData, term: Term, now: number) {
  const clock = localClock(now, data.settings.timezone);
  const { stage, route } = stageAt(inputsOf(data), term, clock);
  const target = targetAt(data, term, now);
  const summary = weeklyAllocation(data, term, monday(clock.day), clock, target);
  const next = recommend(data, term, clock, target);
  const exam = recentExam(data, term, clock);
  return html`<section class="study-card academic-hero">
    <div class="academic-meta"><p>${e(term.name)}</p><p>${stageNames[stage]}${route?.label ? ' · ' + e(route.label) : ''}</p></div>
    <p class="academic-metric" data-academic-total>${duration(summary.total)}</p>
    <p>本周课内投入${summary.budget === null ? ' · Study 尚无周预算' : ' · A 轨计划 ' + duration(summary.budget) +
      (summary.rate === null ? '' : ' · 完成 ' + percent(summary.rate)) + ' · 余量 ' + duration(summary.remaining!)}${summary.budget !== null && summary.total > summary.budget ? ' · 已超计划' : ''}</p>
    <p>${exam ? '最近考试 · ' + e(exam.title) + ' · ' + (exam.distance ? exam.distance + ' 天后' : '今天') : '暂无已确定的待考考试'}
      ${term.examWeek ? ' · 预计考试周 ' + e(term.examWeek) : ''}</p>
  </section>
  ${card('下一步', next ? `<h3>${e(subjectLabel(data, next.subjectId))} · ${e(next.action)}</h3><p>${e(next.reason)}
    ${next.minutes ? ' · 建议 ' + next.minutes + ' 分钟' : ''}</p>` :
    `<p>${stage === 'vacation' ? '休息中，当前没有急项。' : '当前没有需要优先安排的课程。'}</p>`)}
  ${card('本周分配', table(data, summary.minutes, target, summary.total, summary.budget) +
    (summary.crowded && stage !== 'vacation' ? '<p>其他及暂不参与分配的课次占用较多。</p>' : ''))}
  ${card('今日重点', panel('选择其他重点或暂缓', form('next', term.id, subject(data, data.academic.next?.subjectId) +
    textarea('action', '今日行动', data.academic.next?.action) + check('defer', '今天暂缓常规建议', data.academic.next?.defer ?? false) + '<p>留空且取消暂缓可恢复自动建议。已确认的急项会优先显示。</p>'), 'next'))}`;
}

function courseForm(data: DeskData, course: Course) {
  const subjectRow = data.subjects.find(item => item.id === course.subjectId)!;
  return form('course', course.subjectId, grid(input('name', '共享科目名', subjectRow.name, 'maxlength="120" required') +
    select('mode', '课程模式', modes, course.mode) + select('status', '状态', states, course.status) +
    select('activation', '参与分配', { auto: '按日期和模式', on: '已激活', off: '待激活' }, course.activation) +
    dates(course.from, course.through) + check('disabled', '本学期停用', course.disabled) + check('archived', '归档共享科目', subjectRow.archived)) +
    textarea('strategy', '课程策略', course.strategy) + grid(input('focus', '本周重点', course.focus) +
      input('focus2', '本周重点（选填）', course.focus2)) +
    panel('分配和目标参数', grid(number('credits', '学分', course.credits ?? '', .000001, 10000) +
      number('finalShare', '期末占比（%）', toPercent(course.finalShare)) +
      number('cost', '个人成本', course.cost ?? '', .25, 2) + number('goal', '阶段目标（%）', toPercent(course.goal)) +
      number('coverageGoal', '题库覆盖目标（%）', toPercent(course.coverageGoal))),
    'params-' + course.subjectId) + '<p>现有课次、考试和活动计时会继续引用该科目。</p>');
}

function materialForm(item: Partial<Material> = {}) {
  return grid(input('title', '年份或名称', item.title, 'maxlength="120" required') +
    input('location', '位置提示', item.location, 'maxlength="2000"') +
    select('use', '用途', uses, item.use ?? 'unused')) + textarea('note', '摸底或使用备注', item.note);
}

export function courses(data: DeskData, term: Term, now: number) {
  const clock = localClock(now, data.settings.timezone);
  const model = baselineAt(inputsOf(data), term, clock, data.academic.otherId);
  const stats = weeklyAllocation(data, term, monday(clock.day), clock, model.target);
  return card('课程', data.subjects.filter(item => item.track === 'school').map(item => {
    const config = model.courses.find(entry => entry.course.subjectId === item.id);
    const course = config?.course ?? blankCourse(item.id);
    const recent = data.academic.results.filter(result => result.termId === term.id && result.subjectId === item.id)
      .sort((a, b) => b.day.localeCompare(a.day) || b.at - a.at);
    const index = data.academic.materials.filter(row => row.termId === term.id && row.subjectId === item.id);
    const status = item.archived ? '归档' : course.disabled ? '停用' : config?.done ? '考核完成' : config?.stale ? '考试待更新' :
      config?.exam && config.due <= 3 ? '临近考试' : config?.active ? states[course.status] : config ? '暂不分配' : '待配置';
    const aliases = [...new Set(data.academic.aliases.filter(alias => alias.subjectId === item.id).map(alias => alias.name))];
    return panel(item.name + ' · ' + status,
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
          form('material', row.id, materialForm(row)) + button('删除索引', 'delete-material', row.id), 'material-' + row.id)).join('') +
        panel('添加资料', form('material-add', item.id, materialForm()), 'material-new-' + item.id), 'materials-' + item.id),
      'course-' + item.id);
  }).join('') + panel('新增共享科目', form('subject-add', '', input('name', '课程名称', '', 'maxlength="120" required')), 'subject-new'));
}

function assessmentForm(data: DeskData, item: Partial<Assessment> = {}) {
  const exam = data.exams.find(row => row.id === item.examId);
  return grid(subject(data, item.subjectId) + input('title', '标题', item.title, 'maxlength="120" required') +
    select('kind', '类型', kinds, item.kind ?? 'assignment') + select('certainty', '日期状态', certainty, item.certainty ?? 'confirmed') +
    select('status', '办理状态', statuses, item.status ?? 'scheduled') +
    dateInput('day', '截止日或考试日', item.day) + input('time', '截止时刻', item.time, 'type="time"') +
    dateInput('prepare', '准备起日（选填）', item.prepare) + check('required', '必需考核', item.required ?? false)) +
    panel('正式共享考试', grid(input('start', '考试开始', exam?.start, 'type="time"') +
      input('end', '考试结束', exam?.end, 'type="time"') +
      select('importance', 'Study 重要性', { important: '重要', normal: '普通', low: '低' }, exam?.importance ?? 'normal')) +
      '<p>保存确定的考试会编辑 Study 同一场考试，可能改变今后的自动阶段与预算试算。</p>', 'exam-option-' + (item.id ?? 'new'));
}
const routeForm = (route: Partial<Route> = {}) => grid(dates(route.from, route.through, true) +
  select('stage', '训练阶段', stageNames, route.stage ?? 'normal') + input('label', '阶段标签', route.label)) +
  textarea('focus', '阶段重点', route.focus);
export function schedule(data: DeskData, term: Term, now: number) {
  const clock = localClock(now, data.settings.timezone);
  const items = scheduleOf(inputsOf(data), term);
  const practical = items.map(item => {
    const expired = item.kind === 'exam' && item.status === 'scheduled' && item.certainty === 'confirmed' &&
      (item.day < clock.day || item.day === clock.day && clock.minute >= item.cutoff);
    const label = [item.title, item.day || '日期未填', certainty[item.certainty], expired ? '待更新' : statuses[item.status]].join(' · ');
    return panel(label, form('assessment', item.id, assessmentForm(data, { ...item, examId: item.examId })) +
      button('删除此项', 'delete-assessment', item.id), 'due-' + item.id);
  }).join('');
  return card('考试与任务', practical + panel('新增考试或任务', form('assessment', '', assessmentForm(data)), 'new-assessment')) +
    card('复习路线', '<p>阶段影响训练行为。题库课和任务课仍按自身窗口参与分配。</p>' +
      form('stage', term.id, grid(select('override', '手动阶段', { '': '随日期与 Study', ...stageNames }, term.override) +
        dateInput('examWeek', '预计考试周（周一）', term.examWeek))) +
      term.routes.map(route => panel(route.label || stageNames[route.stage], '<p>' + e(route.focus) + '</p>' +
        form('route', route.id, routeForm(route)) + button('移除区间', 'delete-route', route.id), 'route-' + route.id)).join('') +
      panel('新增阶段或休息区间', form('route', '', routeForm()), 'new-route'));
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
  const metric = item?.metric ?? recent?.metric ?? (term.courses.find(course => course.subjectId === id)?.mode === 'task' ? 'done' : 'score');
  return card(item ? '编辑成果' : '录入成果',
    form('result', item?.id ?? '', grid(subject(data, id) + input('activity', '活动', activity, 'list="academic-activities" maxlength="120" required') +
      '<datalist id="academic-activities">' + resultActivities(data, term, id).map(label => '<option value="' + e(label) + '">').join('') + '</datalist>' +
      select('metric', '结果类型', metrics, metric) + dateInput('day', '日期', item?.day ?? today)) +
      '<div class="academic-grid" data-metric-values>' +
      number('value', '实得', item?.value ?? '', 0, 100000) + number('total', '满分或总量', item?.total ?? '', 0, 100000) +
      '<div data-prompted>' + number('prompted', '提示后正确（选填）', item?.prompted ?? '', 0, 100000) + '</div></div>' +
      panel('可比条件、课次与备注', grid(select('sessionId', '关联已保存课次', { '': '不关联', ...sessionOptions }, item?.sessionId) +
        input('scope', '范围或题库', item?.scope) + select('difficulty', '难度', { '': '未分组', foundation: '基础', standard: '标准', advanced: '进阶' }, item?.difficulty) +
        select('condition', '作答条件', conditions, item?.condition ?? 'unknown') + select('attempt', '是否见过', attempts, item?.attempt ?? 'unknown')) +
        grid(tags.map(tag => check('tag-' + tag, tag, item?.tags.includes(tag) ?? false)).join('')) + textarea('note', '备注', item?.note), 'result-detail')) +
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
      table(data, report.minutes, report.history ?? {}, report.total, report.budget) +
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
  const active = term && baselineAt(inputsOf(data), term, clock, data.academic.otherId);
  const terms = data.academic.terms.map(item => panel(item.name + (item.archived ? ' · 归档' : ''),
    form('term', item.id, grid(input('name', '名称', item.name, 'required maxlength="120"') + dates(item.from, item.through, true))) +
    '<div class="study-actions">' + (item.archived ? button('恢复学期', 'unarchive-term', item.id) :
      button('设为当前学期', 'current-term', item.id) + button('归档学期', 'archive-term', item.id)) +
    button('查看此学期', 'inspect-term', item.id) + '</div>', 'term-' + item.id)).join('');
  return card('学期', terms + panel('新增学期', form('term', '', grid(input('name', '名称', '', 'required maxlength="120"') + dates('', '', true)),
    '创建学期'), 'new-term', !data.academic.terms.length)) +
    (term && active ? card('分配设置', form('reserve', term.id, number('reserve', '机动（%）', toPercent(term.reserve), 0, 20)) +
      panel('手动比例与恢复自动', Object.keys(active.weights).length ?
        form('manual', term.id, '<p>填写当前有效课的完整比例，含机动合计 100%。</p>' +
          grid(Object.keys(active.weights).filter(id => id !== reserveId).map(id =>
            number(id, subjectLabel(data, id) + '（%）', toPercent(active.target[id])).replace('step="any"', 'step="any" required')).join('')) +
          '<p>机动 ' + percent(term.reserve) + '</p>') : '<p>配置并激活课程后可自定分配。</p>', 'manual') +
      (term.manual ? button('恢复自动权重', 'auto', term.id) : '')) +
    card('课次归类', form('map-session', term.id, select('sessionId', '待归类课次',
      { '': '请选择', ...Object.fromEntries(data.sessions.filter(item => item.subjectId === data.academic.otherId && inTerm(item.day, term))
        .map(item => [item.id, item.day + ' · ' + item.minutes + ' 分钟 · ' + item.note.slice(0, 40)])) }) +
      subject(data) + '<p>保存前会显示原科目和新科目。</p>') +
      '<p>整门旧课可在课程详情中核对历史名称并明确改名，稳定 ID 会保留。</p>') : '') +
    card('本地备份', '<p>Study 和 Academic 共用当前站点、同一浏览器存储分区的记录。备份包含隐私数据，可主动转移到另一设备。此浏览器及同源脚本可访问这些数据。</p>' +
      '<div class="study-actions">' + button('导出完整 JSON', 'export') + button('选择备份恢复', 'import') +
      '</div><input type="file" accept=".json,application/json" data-backup-file hidden>');
}
