---
title: C++ STL 学习笔记（一）——vector
description: 从原主页迁入，记录 vector 的创建、遍历、排序和去重。
date: 2026-11-07
topic: cpp
section: STL
order: 1
tags: [C++, STL, vector]
---

今天开始系统学习 STL，先从 `vector` 入手。

`vector` 可以理解为动态数组，不需要像普通数组一样提前确定长度，使用时需要包含 `<vector>` 头文件。

## 1. 基本操作

``` cpp
vector<int> a;             // 创建空 vector
vector<int> b(5);          // 5 个元素，初始值为 0
vector<int> c(5, 10);      // 5 个元素，初始值为 10
vector<int> d = {1, 2, 3};

a.push_back(10);           // 末尾添加元素
a.pop_back();              // 删除末尾元素
a.size();                  // 元素数量
a.empty();                 // 判断是否为空
a[0];                      // 下标访问
a.front();                 // 第一个元素
a.back();                  // 最后一个元素
```

注意 `size()` 返回元素数量，下标仍然从 0 开始。`pop_back()`、`front()`、`back()` 都不能对空 vector 使用。

## 2. 遍历

普通 for 循环：

``` cpp
for (int i = 0; i < a.size(); i++) {
    cout << a[i] << " ";
}
```

范围 for 循环：

``` cpp
for (int x : a) {
    cout << x << " ";
}
```

如果需要修改原来的元素，要使用引用：

``` cpp
for (int &x : a) {
    x *= 2;
}
```

## 3. 排序

``` cpp
sort(a.begin(), a.end());                  // 升序
sort(a.begin(), a.end(), greater<int>());  // 降序
```

`begin()` 指向第一个元素，`end()` 指向最后一个元素的后面。

STL 中很多函数使用左闭右开区间 `[begin, end)`。

## 4. 迭代器

迭代器可以暂时理解成类似指针的东西。

``` cpp
vector<int> a = {10, 20, 30};

auto it = a.begin();

cout << *it;  // 10
it++;
cout << *it;  // 20
```

也可以用迭代器遍历：

``` cpp
for (auto it = a.begin(); it != a.end(); it++) {
    cout << *it << " ";
}
```

注意不能解引用 `end()`。

## 5. 去重

``` cpp
vector<int> a = {3, 1, 2, 3, 2, 1};

sort(a.begin(), a.end());
a.erase(unique(a.begin(), a.end()), a.end());
```

结果为 `{1, 2, 3}`。

这里有个容易搞错的地方：**`unique()` 不会真正删除元素**，只是把相邻重复元素压缩到有效区间之外，并返回有效区间末尾的迭代器。

所以一般先 `sort()`，再配合 `erase()` 删除多余元素。

## 6. 时间复杂度

| 操作          | 时间复杂度       |
|---------------|------------------|
| 下标访问      | O(1)             |
| `push_back()` | 均摊 O(1)        |
| `pop_back()`  | O(1)             |
| `sort()`      | O(n log n)       |
| `unique()`    | O(n)             |
| `erase()`     | O(n)（最坏情况） |

今天主要掌握了 vector 的创建、增删、遍历、排序和去重。相比普通数组，写起来方便了不少。

下一部分准备学 `pair`、`tuple` 和自定义排序。
