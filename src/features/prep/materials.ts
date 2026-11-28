import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { client, owner } from '../desk/client.ts';
import { pendingWriteMessage, type WriteOutcome } from '../desk/repository.ts';
import { prepMaterialFileLimit, prepMaterialPath, type DeskData, type PrepMaterial } from './model.ts';
const BUCKET = 'desk-prep-files';
const MARKDOWN_TEXT_LIMIT = 1024 * 1024;
const parser = unified().use(remarkParse);
interface Context {
  termId: string; courseId: string; onError: (error: unknown) => void; read: () => PrepMaterial[];
  update: (mutate: (data: DeskData) => void) => Promise<WriteOutcome>;
}
interface MdNode {
  type: string; value?: string; url?: string; alt?: string; depth?: number;
  ordered?: boolean; start?: number; children?: MdNode[];
}
interface Viewer { kind: 'pdf' | 'markdown'; blob: Blob; filename: string; url?: string }
interface State { context: Context; busy: boolean; message: string; error: boolean; missingId: string; viewer?: Viewer }
const states = new WeakMap<HTMLElement, State>();
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
};
function safeUrl(value: string): URL | null {
  if (!value.trim() || value.length > 4_096) return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}
function safeName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('请填写资料名称。'); if (name.length > 200) throw new Error('资料名称不能超过 200 个字符。');
  return name;
}
function safeFilename(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f/\\]+/g, '-').trim().slice(0, 180) || '资料文件';
}
function safeMime(value: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value) ? value.toLowerCase() : 'application/octet-stream';
}
function markdownNodes(parent: HTMLElement, nodes: MdNode[] = [], depth = 0): void {
  for (const item of nodes) {
    if (depth > 40) continue;
    switch (item.type) {
      case 'heading': {
        const heading = node(item.depth === 1 ? 'h3' : 'h4', `prep-markdown__h${item.depth ?? 2}`);
        markdownNodes(heading, item.children, depth + 1); parent.appendChild(heading);
        break;
      }
      case 'paragraph': {
        const paragraph = node('p'); markdownNodes(paragraph, item.children, depth + 1); parent.appendChild(paragraph);
        break;
      }
      case 'list': {
        const list: HTMLOListElement | HTMLUListElement = item.ordered ? node('ol') : node('ul');
        markdownNodes(list, item.children, depth + 1); parent.appendChild(list);
        break;
      }
      case 'listItem': markdownNodes(parent, item.children, depth + 1); break;
      case 'blockquote': {
        const quote = node('blockquote'); markdownNodes(quote, item.children, depth + 1); parent.appendChild(quote);
        break;
      }
      case 'strong':
      case 'emphasis': {
        const mark = node(item.type === 'strong' ? 'strong' : 'em');
        markdownNodes(mark, item.children, depth + 1); parent.appendChild(mark);
        break;
      }
      case 'inlineCode': parent.appendChild(node('code', '', item.value ?? '')); break;
      case 'code': parent.appendChild(node('pre', 'prep-markdown__code', item.value ?? '')); break;
      case 'link': {
        const url = safeUrl(item.url ?? '');
        if (url) {
          const link = node('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          markdownNodes(link, item.children, depth + 1); parent.appendChild(link);
        } else {
          const label = node('span'); markdownNodes(label, item.children, depth + 1);
          label.append('（链接已隐藏）'); parent.appendChild(label);
        }
        break;
      }
      case 'image':
        parent.appendChild(node('span', 'prep-markdown__image', `［图片未加载：${item.alt || '无说明'}］`));
        break;
      case 'html': parent.appendChild(document.createTextNode(item.value ?? '')); break;
      case 'break': parent.appendChild(node('br')); break;
      case 'text': parent.appendChild(document.createTextNode(item.value ?? '')); break;
      default: markdownNodes(parent, item.children, depth + 1);
    }
  }
}
function markdownDocument(text: string): HTMLElement {
  const article = node('article', 'prep-markdown');
  try {
    markdownNodes(article, (parser.parse(text) as unknown as { children?: MdNode[] }).children);
  } catch { article.textContent = text; }
  return article;
}
const rows = (state: State): PrepMaterial[] => {
  const list = state.context.read();
  return Array.isArray(list)
    ? list.filter((item) => item.termId === state.context.termId && item.courseId === state.context.courseId)
    : [];
};
const material = (state: State, id: string): PrepMaterial => {
  const item = rows(state).find((row) => row.id === id);
  if (!item) throw new Error('资料已变化，请刷新后重试。');
  return item;
};
const isMarkdown = (item: PrepMaterial) => /\.(?:md|markdown)$/i.test(item.filename ?? '') ||
  ['text/markdown', 'text/x-markdown'].includes(item.mime ?? '');
const isPdf = (item: PrepMaterial) => item.mime === 'application/pdf' || /\.pdf$/i.test(item.filename ?? '');
function button(label: string, action: string, id = '', danger = false): HTMLButtonElement {
  const result = node('button', `study-action${danger ? ' danger' : ''}`, label);
  result.type = 'button'; result.dataset.prepAction = action;
  if (id) result.dataset.prepId = id;
  return result;
}
const failure = (state: State, error: unknown): void => {
  state.error = true;
  state.message = error instanceof Error ? error.message : '操作未完成，请重试。';
  try {
    state.context.onError(error);
  } catch {
    // Keep the local status when the page-level reporter is unavailable.
  }
};
const closeViewer = (state: State): void => {
  if (state.viewer?.url) URL.revokeObjectURL(state.viewer.url);
  state.viewer = undefined;
};
function render(state: State, container: HTMLElement): void {
  closeViewer(state);
  const section = node('section', 'study-card prep-materials');
  section.setAttribute('aria-busy', String(state.busy));
  section.innerHTML =
    '<div class="study-between prep-materials__heading"><div><h2>课程资料</h2>' +
    '<p class="study-muted">文件最大 25 MiB，仅当前登录账号可访问。</p></div>' +
    '<div class="study-actions"><button class="study-action primary" type="button" ' +
    'data-prep-action="upload">上传文件</button><button class="study-action" type="button" ' +
    'data-prep-action="add-link">添加链接</button></div></div>';
  section.querySelectorAll<HTMLButtonElement>('button').forEach((item) => { item.disabled = state.busy; });
  if (state.message) {
    const status = node('p', 'study-status prep-materials__status', state.message);
    status.setAttribute('role', state.error ? 'alert' : 'status'); status.toggleAttribute('data-error', state.error);
    section.appendChild(status);
  }

  const list = node('ul', 'study-list prep-materials__list');
  const items = rows(state).sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id));
  if (!items.length) list.appendChild(node('li', 'study-muted', '这个课程还没有资料。'));
  for (const item of items) {
    const row = node('li', `prep-material${item.removing ? ' is-removing' : ''}`);
    row.dataset.prepId = item.id;
    const info = node('div', 'prep-material__body');
    const title = node('div', 'prep-material__title');
    title.append(node('span', 'prep-material__name', item.name),
      node('span', 'prep-material__kind', item.kind === 'link' ? '链接' : '文件'));
    info.appendChild(title);
    const url = item.kind === 'link' && item.url ? safeUrl(item.url) : null;
    info.appendChild(node('p', 'study-muted prep-material__detail', item.kind === 'file'
      ? [item.filename, item.bytes == null ? '' : `${(item.bytes / 1_024 / 1_024).toFixed(2)} MiB`]
        .filter(Boolean).join(' · ')
      : url?.host || '链接地址无效'));
    if (item.removing) info.appendChild(node('p', 'study-callout caution', '删除停在文件清理步骤，请继续重试。'));
    row.appendChild(info);

    const actions = node('div', 'study-actions prep-material__actions');
    if (item.removing) actions.appendChild(button('继续删除', 'retry-delete', item.id, true));
    else {
      if (url) {
        const link = node('a', 'study-action', '打开'); link.href = url.href;
        link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.appendChild(link);
      } else if (item.kind === 'file') {
        if (isMarkdown(item)) actions.append(button('阅读', 'read-markdown', item.id), button('下载', 'download', item.id));
        else if (isPdf(item)) actions.append(button('打开', 'open-pdf', item.id), button('下载', 'download', item.id));
        else actions.appendChild(button('下载', 'download', item.id));
        if (state.missingId === item.id) actions.appendChild(button('补充缺失文件', 'restore', item.id));
      }
      actions.append(button('重命名', 'rename', item.id), button('删除', 'delete', item.id, true));
    }
    actions.querySelectorAll<HTMLButtonElement>('button').forEach((item) => { item.disabled = state.busy; });
    row.appendChild(actions);
    list.appendChild(row);
  }
  section.appendChild(list);

  const upload = document.createElement('input'); upload.type = 'file'; upload.hidden = true; upload.dataset.prepInput = 'upload';
  const restore = document.createElement('input'); restore.type = 'file'; restore.hidden = true; restore.dataset.prepInput = 'restore';
  const dialog = node('dialog', 'study-card prep-materials__dialog');
  dialog.dataset.prepDialog = '';
  dialog.innerHTML =
    '<form class="study-form" data-prep-form><h2 data-dialog-title></h2>' +
    '<label class="study-field">名称<input name="name" maxlength="200" required></label>' +
    '<label class="study-field" data-url-field>外部链接（仅 HTTP / HTTPS）' +
    '<input name="url" type="url" inputmode="url" placeholder="https://"></label>' +
    '<div class="study-actions"><button class="study-action primary" type="submit">保存</button>' +
    '<button class="study-action" type="button" data-prep-action="close-dialog">取消</button></div></form>';
  section.append(upload, restore, dialog);
  container.replaceChildren(section);
}
async function ensureOwner(expected: string): Promise<void> {
  if (await owner() !== expected) throw new Error('登录账号已变化，已停止文件操作。');
}
async function cloudMaterial(
  ownerId: string,
  id: string,
  expected: (value: PrepMaterial) => boolean,
): Promise<void> {
  await ensureOwner(ownerId);
  const { data, error } = await client().rpc('desk_snapshot');
  if (error) throw error;
  const row = Array.isArray(data) && data.find((item: { kind?: string; id?: string }) =>
    item.kind === 'prepMaterials' && item.id === id);
  const payload = row?.payload as PrepMaterial | undefined;
  if (!row || row.deleted === true || !payload || !expected(payload)) {
    throw new Error('资料元数据尚未得到云端确认。请重试。');
  }
  await ensureOwner(ownerId);
}
function writeStatus(state: State, outcome: WriteOutcome, confirmed: string, next = '') {
  state.error = outcome === 'conflict';
  state.message = outcome === 'confirmed' ? confirmed : pendingWriteMessage(outcome) + next;
}

async function putObject(ownerId: string, id: string, file: File, type: string): Promise<'uploaded' | 'exists'> {
  const { error } = await client().storage.from(BUCKET).upload(prepMaterialPath(ownerId, id), file, {
    cacheControl: '0',
    contentType: type,
    upsert: false,
  });
  const code = error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  const duplicate = error && (error.status === 409 || /already exists|duplicate|ResourceAlreadyExists/i.test(code + ' ' + error.message));
  if (error && !duplicate) throw new Error(`文件上传失败。${error.message}`);
  return duplicate ? 'exists' : 'uploaded';
}
async function addFile(state: State, file: File): Promise<void> {
  if (!file.size || file.size > prepMaterialFileLimit) throw new Error('文件必须非空且不超过 25 MiB。');
  const ownerId = await owner();
  const item: PrepMaterial = {
    id: crypto.randomUUID(), termId: state.context.termId, courseId: state.context.courseId,
    name: safeName(file.name), kind: 'file', filename: safeFilename(file.name),
    mime: safeMime(file.type), bytes: file.size,
  };
  const outcome = await state.context.update((data) => { (data.prepMaterials ??= []).push(item); });
  state.missingId = item.id;
  if (outcome !== 'confirmed') {
    writeStatus(state, outcome, '', '同步后可用“补充缺失文件”上传原文件。');
    return;
  }
  await cloudMaterial(ownerId, item.id, (value) => value.kind === 'file' && value.removing !== true);
  try {
    await putObject(ownerId, item.id, file, item.mime ?? 'application/octet-stream');
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    throw new Error('资料已登记，文件传输未确认。请用“补充缺失文件”重试。' + detail);
  }
  await cloudMaterial(ownerId, item.id, (value) => value.kind === 'file' && value.removing !== true);
  state.missingId = '';
  state.error = false;
  state.message = `“${item.name}”已上传。`;
}
async function addLink(state: State, name: string, value: string): Promise<void> {
  const url = safeUrl(value);
  if (!url) throw new Error('外部链接必须是有效的 HTTP 或 HTTPS 地址，且不能包含账号密码。');
  const item: PrepMaterial = {
    id: crypto.randomUUID(), termId: state.context.termId, courseId: state.context.courseId,
    name: safeName(name), kind: 'link', url: url.href,
  };
  const outcome = await state.context.update((data) => { (data.prepMaterials ??= []).push(item); });
  writeStatus(state, outcome, `“${item.name}”已添加。`);
}
async function rename(state: State, id: string, value: string): Promise<void> {
  const name = safeName(value);
  const current = material(state, id);
  const outcome = await state.context.update((data) => {
    const item = data.prepMaterials?.find((row) =>
      row.id === id && row.termId === current.termId && row.courseId === current.courseId);
    if (!item || item.removing) throw new Error('资料已变化，请刷新后重试。');
    item.name = name;
  });
  writeStatus(state, outcome, '资料名称已保存。');
}
async function remove(state: State, id: string): Promise<void> {
  const ownerId = await owner();
  const current = material(state, id);
  const marked = await state.context.update((data) => {
    const item = data.prepMaterials?.find((row) =>
      row.id === id && row.termId === current.termId && row.courseId === current.courseId);
    if (!item || item.kind !== current.kind) throw new Error('资料已变化，请刷新后重试。');
    item.removing = true;
  });
  if (marked !== 'confirmed') {
    writeStatus(state, marked, '', '同步后请点击“继续删除”。');
    return;
  }
  await cloudMaterial(ownerId, id, (value) => value.kind === current.kind && value.removing === true);
  if (current.kind === 'file') {
    const { error } = await client().storage.from(BUCKET)
      .remove([prepMaterialPath(ownerId, id)]);
    if (error) throw new Error(`删除云端文件失败。${error.message}`);
    await ensureOwner(ownerId);
  }
  const outcome = await state.context.update((data) => {
    const index = data.prepMaterials?.findIndex((row) =>
      row.id === id && row.termId === current.termId && row.courseId === current.courseId) ?? -1;
    if (index < 0 || data.prepMaterials?.[index].removing !== true) {
      throw new Error('删除标记已变化，未移除资料记录。');
    }
    data.prepMaterials.splice(index, 1);
  });
  state.missingId = state.missingId === id ? '' : state.missingId;
  writeStatus(state, outcome, '资料已删除。');
}
async function getBytes(state: State, id: string): Promise<{ item: PrepMaterial; blob: Blob }> {
  const ownerId = await owner();
  const item = material(state, id);
  const { data, error } = await client().storage.from(BUCKET).download(
    prepMaterialPath(ownerId, item.id),
    { cacheNonce: crypto.randomUUID() },
    { cache: 'no-store' },
  );
  if (error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
    if (error.status === 404 || /not[\s_-]*found|NoSuchKey/i.test(code + ' ' + error.message)) {
      state.missingId = id;
      throw new Error('云端文件缺失，可从独立保存的文件补充到同一资料。');
    }
    throw new Error(`读取文件失败。${error.message}`);
  }
  if (!data) {
    state.missingId = id;
    throw new Error('云端文件缺失，可从独立保存的文件补充。');
  }
  await ensureOwner(ownerId);
  return { item, blob: data };
}
function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename(name);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
async function hasPdfSignature(blob: Blob): Promise<boolean> {
  if (blob.size < 5) return false;
  return String.fromCharCode(...new Uint8Array(await blob.slice(0, 5).arrayBuffer())) === '%PDF-';
}
function showViewer(state: State, container: HTMLElement, item: PrepMaterial,
  blob: Blob, kind: Viewer['kind'], text = ''): void {
  const url = kind === 'pdf' ? URL.createObjectURL(new Blob([blob], { type: 'application/pdf' })) : undefined;
  state.viewer = { kind, blob, filename: item.filename ?? item.name, url };
  const dialog = node('dialog', 'prep-materials__viewer');
  dialog.dataset.prepReader = kind;
  dialog.setAttribute('aria-label', `${item.name} ${kind === 'pdf' ? 'PDF 查看器' : 'Markdown 阅读器'}`);
  const header = node('div', 'study-between prep-materials__viewer-header');
  const actions = node('div', 'study-actions');
  actions.append(button('下载', 'viewer-download'), button('关闭', 'close-viewer'));
  header.append(node('h2', '', item.name), actions);
  const content = node('div', 'prep-materials__viewer-content');
  content.dataset.prepReaderContent = '';
  if (kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = url!;
    frame.title = `${item.name} PDF`;
    frame.dataset.prepPdf = '';
    content.appendChild(frame);
  } else {
    content.appendChild(markdownDocument(text));
  }
  dialog.append(header, content);
  dialog.addEventListener('close', () => {
    closeViewer(state);
    dialog.remove();
    if (container.isConnected) {
      render(state, container);
      container.querySelector<HTMLButtonElement>(
        `[data-prep-id="${CSS.escape(item.id)}"][data-prep-action="${kind === 'pdf' ? 'open-pdf' : 'read-markdown'}"]`,
      )?.focus();
    }
  }, { once: true });
  container.appendChild(dialog);
  dialog.showModal();
}
async function restore(state: State, id: string, file: File): Promise<void> {
  if (!file.size || file.size > prepMaterialFileLimit) throw new Error('文件必须非空且不超过 25 MiB。');
  const current = material(state, id);
  if (current.kind !== 'file' || current.removing) throw new Error('该资料当前不能补充文件。');
  const ownerId = await owner();
  const outcome = await state.context.update((data) => {
    if (!data.prepMaterials?.some((item) => item.id === id && item.kind === 'file' && !item.removing)) {
      throw new Error('资料已变化，请刷新后重试。');
    }
  });
  if (outcome !== 'confirmed') {
    writeStatus(state, outcome, '', '同步后可继续补充文件。');
    return;
  }
  await cloudMaterial(ownerId, id, (value) => value.kind === 'file' && value.removing !== true);
  const result = await putObject(ownerId, id, file, safeMime(file.type));
  await cloudMaterial(ownerId, id, (value) => value.kind === 'file' && value.removing !== true);
  if (result === 'exists') {
    state.missingId = '';
    state.error = false;
    state.message = '云端文件已存在；为保护不可变对象，未覆盖文件或修改名称、类型和大小。';
    return;
  }
  const updated = await state.context.update((data) => {
    const item = data.prepMaterials?.find((row) =>
      row.id === id && row.termId === current.termId && row.courseId === current.courseId);
    if (!item || item.removing || item.kind !== 'file') throw new Error('资料已变化，文件已上传但元数据未更新。');
    item.filename = safeFilename(file.name);
    item.mime = safeMime(file.type);
    item.bytes = file.size;
  });
  state.missingId = '';
  writeStatus(state, updated, '文件已补充到原资料。');
}
async function act(state: State, container: HTMLElement, message: string, task: () => Promise<void>): Promise<void> {
  if (state.busy) return; state.busy = true; state.error = false;
  state.message = message;
  render(state, container);
  try { await task(); }
  catch (error) { failure(state, error); }
  finally {
    state.busy = false;
    if (state.viewer) container.querySelector('.prep-materials')?.setAttribute('aria-busy', 'false');
    else render(state, container);
  }
}
function openDialog(state: State, container: HTMLElement, mode: 'link' | 'rename', id = ''): void {
  const dialog = container.querySelector<HTMLDialogElement>('[data-prep-dialog]');
  const form = dialog?.querySelector<HTMLFormElement>('[data-prep-form]');
  if (!dialog || !form) return;
  form.dataset.mode = mode; form.dataset.id = id;
  const name = form.elements.namedItem('name') as HTMLInputElement;
  const url = form.elements.namedItem('url') as HTMLInputElement;
  const field = form.querySelector<HTMLElement>('[data-url-field]')!;
  form.querySelector<HTMLElement>('[data-dialog-title]')!.textContent = mode === 'link' ? '添加外部链接' : '重命名资料';
  name.value = mode === 'rename' ? material(state, id).name : '';
  url.value = ''; url.required = mode === 'link'; field.hidden = mode !== 'link';
  dialog.showModal(); name.focus();
}
function bind(container: HTMLElement, state: State): void {
  container.addEventListener('click', (event) => {
    const control = (event.target as HTMLElement).closest<HTMLElement>('[data-prep-action]');
    if (!control || state.busy) return;
    const action = control.dataset.prepAction;
    const id = control.dataset.prepId ?? '';
    if (action === 'upload') container.querySelector<HTMLInputElement>('[data-prep-input="upload"]')?.click();
    else if (action === 'add-link') openDialog(state, container, 'link');
    else if (action === 'rename') {
      try { openDialog(state, container, 'rename', id); } catch (error) { failure(state, error); render(state, container); }
    } else if (action === 'close-dialog') container.querySelector<HTMLDialogElement>('[data-prep-dialog]')?.close();
    else if (action === 'close-viewer') container.querySelector<HTMLDialogElement>('[data-prep-reader]')?.close();
    else if (action === 'viewer-download' && state.viewer) save(state.viewer.blob, state.viewer.filename);
    else if (action === 'retry-delete') void act(state, container, '正在继续删除…', () => remove(state, id));
    else if (action === 'delete') {
      if (confirm(`删除“${material(state, id).name}”？`)) void act(state, container, '正在删除…', () => remove(state, id));
    } else if (action === 'download' || action === 'open-pdf' || action === 'read-markdown') {
      void act(state, container, '正在读取文件…', async () => {
        const { item, blob } = await getBytes(state, id);
        if (action === 'read-markdown') {
          if (blob.size > MARKDOWN_TEXT_LIMIT) throw new Error('Markdown 文件超过 1 MiB，请下载后查看。');
          const text = new TextDecoder('utf-8', { fatal: false }).decode(await blob.arrayBuffer());
          state.message = '';
          showViewer(state, container, item, blob, 'markdown', text);
        } else if (action === 'open-pdf' && await hasPdfSignature(blob)) {
          state.message = '';
          showViewer(state, container, item, blob, 'pdf');
        } else {
          save(blob, item.filename ?? item.name);
          state.message = action === 'open-pdf' ? '文件签名不是有效 PDF，已改为下载。' : '文件已交给浏览器下载。';
        }
      });
    } else if (action === 'restore') {
      const input = container.querySelector<HTMLInputElement>('[data-prep-input="restore"]');
      if (input) { input.dataset.prepId = id; input.click(); }
    }
  });
  container.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.matches('[data-prep-input]')) return;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (input.dataset.prepInput === 'restore') {
      void act(state, container, '正在补充文件…', () => restore(state, input.dataset.prepId ?? '', file));
    } else {
      void act(state, container, '正在上传…', () => addFile(state, file));
    }
  });
  container.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches('[data-prep-form]')) return;
    event.preventDefault();
    if (state.busy) return;
    const fields = new FormData(form);
    const mode = form.dataset.mode;
    const id = form.dataset.id ?? '';
    const name = String(fields.get('name') ?? '');
    const url = String(fields.get('url') ?? '');
    container.querySelector<HTMLDialogElement>('[data-prep-dialog]')?.close();
    if (mode === 'link') void act(state, container, '正在添加链接…', () => addLink(state, name, url));
    else if (mode === 'rename') void act(state, container, '正在保存名称…', () => rename(state, id, name));
  });
}
export function createMaterials(container: HTMLElement, context: Context): void {
  let state = states.get(container);
  if (!state) {
    state = { context, busy: false, message: '', error: false, missingId: '' };
    states.set(container, state); bind(container, state);
  } else state.context = context;
  render(state, container);
}
