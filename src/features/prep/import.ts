export interface PrepTask {
  sourceKey: string; generated: boolean; week: number; title: string; notes: string; done: boolean;
}
export interface PrepImportResult {
  course: string; tasks: PrepTask[]; warnings: string[]; notes: string;
}
interface DraftTask {
  sourceKey?: string; week: number; title: string; noteParts: string[];
  done: boolean; identity: string; lineNumber: number;
}
type TaskTable = {
  start: number; end: number; hasSeparator: boolean;
  rows: Array<{ cells: string[]; lineNumber: number }>;
};
type WeekContext = { goal?: string; acceptance?: string };

const HEADERS = ["id", "week", "type", "title", "scope", "status", "notes"];
const CHECKBOX = /^\s*- \[([ xX])\] (.+?)\s*$/;
const CHECKBOX_START = /^\s*- \[/;
const WEEK_HEADING = /^\s{0,3}##\s*第\s*(\d+)\s*周\s*$/;
const WEEK_CONTEXT =
  /^\s*\*\*(阶段目标|闭卷验收)\*\*\s*[:：]?\s*(.+?)\s*$/;

export function parsePrepMarkdown(text: string): PrepImportResult {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const warnings: string[] = [];
  const course = findMetadataCourse(lines) || cleanCourseTitle(findH1(lines));
  if (!course) {
    warnings.push("未找到课程名称；请提供“科目”字段或一级标题。");
  }
  const table = findTaskTable(lines);
  const weekly = table ? null : parseWeeklySections(lines, warnings);
  const drafts = table
    ? parseTaskTable(table, course, warnings)
    : (weekly?.tasks ?? []);

  if (!drafts.length) warnings.push("未找到可导入的周任务。");
  const tasks = identifyTasks(drafts, warnings);
  const notes = extractCourseNotes(lines, table, weekly?.firstWeekLine);
  return { course, tasks, warnings, notes };
}

function parseTaskTable(
  table: TaskTable,
  course: string,
  warnings: string[],
): DraftTask[] {
  if (!table.hasSeparator) {
    warnings.push(`第 ${table.start + 1} 行：任务表缺少分隔行，已尽力解析。`);
  }
  const tasks: DraftTask[] = [];
  for (const row of table.rows) {
    const cells = HEADERS.map((_, index) => row.cells[index]?.trim() ?? "");
    if (row.cells.length !== HEADERS.length) {
      warnings.push(
        `第 ${row.lineNumber + 1} 行：任务表应有 7 列，实际为 ${row.cells.length} 列，已跳过。`,
      );
      continue;
    }

    const [id, weekText, type, title, scope, status, notes] = cells;
    const week = parseWeek(weekText ?? "");
    if (!week) {
      warnings.push(
        `第 ${row.lineNumber + 1} 行：周次“${weekText || "(空)"}”无效，已跳过。`,
      );
      continue;
    }
    if (!title) {
      warnings.push(
        `第 ${row.lineNumber + 1} 行：第 ${week} 周的任务标题为空，已跳过。`,
      );
      continue;
    }

    const state = parseTableStatus(status ?? "");
    if (!state.recognized) {
      warnings.push(
        `第 ${row.lineNumber + 1} 行：状态“${status}”无法识别，按未完成处理。`,
      );
    }
    tasks.push({
      sourceKey: id || undefined,
      week,
      title,
      noteParts: [
        type ? `类型：${type}` : "",
        scope ? `范围：${scope}` : "",
        notes ? `备注：${notes}` : "",
      ],
      done: state.done,
      identity: [course, week, type, title, scope, notes].join("\0"),
      lineNumber: row.lineNumber + 1,
    });
  }
  return tasks;
}

function parseWeeklySections(
  lines: string[],
  warnings: string[],
): { tasks: DraftTask[]; firstWeekLine: number } {
  const tasks: DraftTask[] = [];
  const contexts = new Map<number, WeekContext>();
  let currentWeek: number | null = null;
  let firstWeekLine = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const weekMatch = line.match(WEEK_HEADING);
    if (weekMatch) {
      currentWeek = parseWeek(weekMatch[1] ?? "");
      if (currentWeek === null) warnings.push(`第 ${index + 1} 行：周次无效。`);
      firstWeekLine = Math.min(firstWeekLine, index);
      continue;
    }

    if (/^\s{0,3}#{1,2}\s+/.test(line)) {
      currentWeek = null;
      continue;
    }
    const contextMatch = line.match(WEEK_CONTEXT);
    if (contextMatch && currentWeek !== null) {
      const context = contexts.get(currentWeek) ?? {};
      if (contextMatch[1] === "阶段目标") {
        context.goal = contextMatch[2]?.trim();
      } else {
        context.acceptance = contextMatch[2]?.trim();
      }
      contexts.set(currentWeek, context);
      continue;
    }
    if (!CHECKBOX_START.test(line)) continue;
    const checkbox = line.match(CHECKBOX);
    if (!checkbox) {
      warnings.push(`第 ${index + 1} 行：复选框格式无效，已跳过。`);
      continue;
    }
    if (currentWeek === null) {
      warnings.push(
        `第 ${index + 1} 行：复选框不在“第 N 周”标题下，已跳过。`,
      );
      continue;
    }
    const title = checkbox[2]?.trim();
    if (!title) {
      warnings.push(`第 ${index + 1} 行：任务内容为空，已跳过。`);
      continue;
    }
    tasks.push({
      week: currentWeek,
      title,
      noteParts: [],
      done: checkbox[1]?.toLowerCase() === "x",
      identity: `weekly\0${currentWeek}\0${title}`,
      lineNumber: index + 1,
    });
  }
  for (const task of tasks) {
    const context = contexts.get(task.week);
    if (context?.goal) task.noteParts.push(`周目标：${context.goal}`);
    if (context?.acceptance) {
      task.noteParts.push(`闭卷验收：${context.acceptance}`);
    }
  }
  return { tasks, firstWeekLine };
}
function findMetadataCourse(lines: string[]): string {
  for (const line of lines) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells[0] === "科目") return cells[1] ?? "";
  }
  return "";
}
function findH1(lines: string[]): string {
  const line = lines.find((value) => /^\s{0,3}#\s+/.test(value));
  return line?.replace(/^\s{0,3}#\s+/, "").trim() ?? "";
}
function cleanCourseTitle(title: string): string {
  return title.replace(/\s*(?:期末)?备考(?:周任务|计划)?\s*$/, "").trim();
}
function findTaskTable(lines: string[]): TaskTable | null {
  for (let start = 0; start < lines.length; start += 1) {
    const headers = splitRow(lines[start] ?? "");
    if (headers.join("\0") !== HEADERS.join("\0")) continue;

    const hasSeparator = isSeparator(lines[start + 1] ?? "");
    const rows: TaskTable["rows"] = [];
    let end = start + (hasSeparator ? 2 : 1);
    while ((lines[end] ?? "").trimStart().startsWith("|")) {
      rows.push({ cells: splitRow(lines[end] ?? ""), lineNumber: end });
      end += 1;
    }
    return { start, end, rows, hasSeparator };
  }
  return null;
}
function isSeparator(line: string): boolean {
  const cells = line.trimStart().startsWith("|") ? splitRow(line) : [];
  return (
    cells.length === HEADERS.length &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}
function parseWeek(value: string): number | null {
  const week = Number(value.match(/^W?(\d+)$/i)?.[1]);
  return Number.isSafeInteger(week) && week > 0 ? week : null;
}
function parseTableStatus(value: string): {
  done: boolean; recognized: boolean;
} {
  if (!value || value === "待办") return { done: false, recognized: true };
  if (value === "已完成") return { done: true, recognized: true };
  return { done: false, recognized: false };
}
function identifyTasks(drafts: DraftTask[], warnings: string[]): PrepTask[] {
  const seen = new Set<string>();
  const tasks: PrepTask[] = [];
  for (const task of drafts) {
    const sourceKey = task.sourceKey ?? `prep-w${task.week}-${hash(task.identity)}`;
    if (seen.has(sourceKey)) {
      warnings.push(`第 ${task.lineNumber} 行：任务标识或清单内容重复（${sourceKey}），已跳过。`);
      continue;
    }
    seen.add(sourceKey);
    tasks.push({
      sourceKey,
      generated: !task.sourceKey,
      week: task.week,
      title: task.title,
      notes: cleanNote(task.noteParts),
      done: task.done,
    });
  }
  return tasks;
}
function hash(value: string): string {
  let result = 14695981039346656037n;
  for (const character of value) {
    result = BigInt.asUintN(64, (result ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
  }
  return result.toString(36);
}
function extractCourseNotes(
  lines: string[],
  table: TaskTable | null,
  firstWeekLine?: number,
): string {
  let excludedStart = firstWeekLine ?? lines.length;
  let excludedEnd = lines.length;
  if (table) {
    const section = lines.findIndex(
      (line, index) =>
        index < table.start && /^\s{0,3}##\s*任务数据\s*$/.test(line),
    );
    excludedStart = section >= 0 ? section : table.start;
    excludedEnd = table.end;
  }
  return lines
    .filter((line, index) => {
      const isH1 = index === 0 && /^\s{0,3}#\s+/.test(line);
      const isExcluded = index >= excludedStart && index < excludedEnd;
      return !isH1 && !isExcluded;
    })
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function cleanNote(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n");
}
