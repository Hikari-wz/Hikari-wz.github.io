import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parsePrepMarkdown } from "../src/features/prep/import.ts";

const sourcePaths = process.argv
  .slice(2)
  .filter((argument) => argument !== "--")
  .map((argument) => path.resolve(argument));

test("parses the fixed task table, terminal notes, and duplicate IDs", () => {
  const result = parsePrepMarkdown(`# 测试课程期末备考计划

## 基本信息

| 字段 | 内容 |
| --- | --- |
| 科目 | 测试课程 |

## 执行规则

- 每周复盘一次。

## 任务数据

| id | week | type | title | scope | status | notes |
| --- | --- | --- | --- | --- | --- | --- |
| t-A1 | W1 | 新学 | 明确任务 | 覆盖 a\\|b 与边界 | 待办 | 先做诊断 |
| t-A1 | W1 | 补旧 | 重复标识任务 | 保留范围 | 已完成 |  |
|  | W2 | 综合 | 无编号任务 | 闭卷练习 | 待办 |  |
| bad | Wbad | 新学 | 坏周次 | 不应导入 | 待办 |  |
| bad-columns | W3 | 新学 | 缺少一列 | 范围 | 待办 |

## 考情摘要

这段终端说明应进入总备注。
`);

  assert.equal(result.course, "测试课程");
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0]?.sourceKey, "t-A1");
  assert.match(result.tasks[1]?.sourceKey ?? "", /^prep-w2-/);
  assert.match(result.tasks[0]?.notes ?? "", /范围：覆盖 a\|b 与边界/);
  assert.equal(result.tasks[1]?.done, false);
  assert.match(result.notes, /## 执行规则/);
  assert.match(result.notes, /这段终端说明应进入总备注/);
  assert.doesNotMatch(result.notes, /先做诊断/);
  assert.ok(result.warnings.some((warning) => warning.includes("重复")));
  assert.ok(result.warnings.some((warning) => warning.includes("Wbad")));
  assert.ok(result.warnings.some((warning) => warning.includes("应有 7 列")));
});

test("parses weekly checkboxes and retains acceptance in task notes", () => {
  const result = parsePrepMarkdown(`# 大学英语期末备考周任务

闭卷作答时合上资料。

## 第 1 周

**阶段目标**　完成首轮诊断

- [ ] 必做｜做一组听力。
- [x] 选做｜补一组短文。

**闭卷验收**　记录答对数和正确率。

## 第 2 周

- [ ] 必做｜复测错项。

**闭卷验收**　错项能够独立说明原因。
`);

  assert.equal(result.course, "大学英语");
  assert.equal(result.tasks.length, 3);
  assert.equal(result.tasks[0]?.title, "必做｜做一组听力。");
  assert.equal(result.tasks[1]?.title, "选做｜补一组短文。");
  assert.equal(result.tasks[1]?.done, true);
  assert.match(result.tasks[0]?.notes ?? "", /周目标：完成首轮诊断/);
  assert.match(result.tasks[0]?.notes ?? "", /闭卷验收：记录答对数和正确率/);
  assert.match(result.tasks[2]?.notes ?? "", /错项能够独立说明原因/);
  assert.match(result.notes, /合上资料/);
  assert.doesNotMatch(result.notes, /## 第 1 周/);
  assert.deepEqual(result.warnings, []);
});

test("warns on malformed or unowned checkbox lines", () => {
  const result = parsePrepMarkdown(`# 坏格式期末备考周任务

- [x]
- [ ] 没有周次的任务
`);

  assert.equal(result.course, "坏格式");
  assert.equal(result.tasks.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("格式无效")));
  assert.ok(
    result.warnings.some((warning) => warning.includes("不在“第 N 周”标题下")),
  );
});

test(
  "verifies source files supplied through argv",
  { skip: sourcePaths.length === 0 && "pass source paths as arguments" },
  () => {
    const expected = new Map([
      ["高等数学", 29],
      ["C 语言", 19],
      ["中国近现代史纲要", 32],
      ["计算机导论", 19],
      ["大学英语（一）", 18],
    ]);
    const seen = new Set();

    for (const sourcePath of sourcePaths) {
      const result = parsePrepMarkdown(fs.readFileSync(sourcePath, "utf8"));
      assert.ok(result.course, `${sourcePath} should have a course`);
      assert.ok(result.tasks.length, `${sourcePath} should have tasks`);
      assert.deepEqual(result.warnings, [], `${sourcePath} warnings`);
      assert.equal(
        new Set(result.tasks.map((task) => task.sourceKey)).size,
        result.tasks.length,
        `${sourcePath} source keys`,
      );

      const count = expected.get(result.course);
      if (count !== undefined) {
        assert.equal(result.tasks.length, count, result.course);
        seen.add(result.course);
      }
      if (result.tasks.some((task) => !task.generated)) {
        assert.ok(result.tasks.every((task) => !task.generated));
        assert.match(result.notes, /## 考情摘要/);
        assert.match(result.notes, /## 来源与版本说明/);
      }

      const withAcceptance = result.tasks.filter((task) =>
        task.notes.includes("闭卷验收："),
      ).length;
      if (["中国近现代史纲要", "计算机导论", "大学英语（一）"].includes(result.course)) {
        assert.equal(withAcceptance, result.tasks.length);
      }

      for (const task of result.tasks) {
        assert.ok(Number.isInteger(task.week) && task.week > 0);
        assert.ok(task.title);
        assert.doesNotMatch(task.notes, /预计耗时|时间预算/i);
      }
    }

    if (sourcePaths.length === expected.size) {
      assert.deepEqual([...seen].sort(), [...expected.keys()].sort());
    }
  },
);
