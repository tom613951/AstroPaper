---
author: Sat Naing
pubDatetime: 2026-05-27T08:53:00Z
title: 快速上手：如何使用 Markdown 写作？
postSlug: how-to-write-markdown-post
featured: false
draft: false
tags:
  - 教程
  - Markdown
description: 简明 Markdown 写作指南，帮助你快速掌握基础排版语法，并直接用于本博客的文章创作中。
---

# 简明 Markdown 写作指南

Markdown 是一种轻量级标记语言，它允许人们使用易读易写的纯文本格式编写文档。本博客完全支持 Markdown 和 MDX，你可以直接利用这些语法撰写美观的内容。

## 基础语法介绍

### 1. 标题
在行首插入 1 到 6 个 `#`，分别表示一级标题到六级标题。例如：
```markdown
# 一级标题
## 二级标题
### 三级标题
```

### 2. 列表
无序列表使用减号 `-`、加号 `+` 或星号 `*`：
- 项目一
- 项目二
- 项目三

有序列表使用数字加英文句点：
1. 第一步
2. 第二步
3. 第三步

### 3. 代码高亮
如果是单行代码，使用单个反引号包裹：`const site = "Astro";`。
如果是多行代码块，使用三个反引号包裹，并可以指定语言名称：

```js
// 这是一段 JavaScript 代码
function greet(name) {
  console.log(`你好, ${name}!`);
}
greet("世界");
```

### 4. 引用
在行首使用大于号 `>`：
> 这是一个引用段落。Markdown 让写作变得纯粹而快乐。

### 5. 图片与链接
- 链接格式：`[链接文本](URL)`。例如：[GitHub](https://github.com)。
- 图片格式：`![图片描述](图片地址)`。

---

现在，你可以尝试在 `src/content/posts/` 目录下创建你自己的 `.md` 文件，开始你的博客创作之旅吧！
