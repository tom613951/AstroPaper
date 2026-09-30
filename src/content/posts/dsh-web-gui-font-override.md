---
author: tom613951
pubDatetime: 2026-09-30T00:00:00Z
title: DSH Web GUI 字体覆盖：主题 token 逆向、UA 继承链断裂与一个静默的 CSS 语法陷阱
postSlug: dsh-web-gui-font-override
featured: false
draft: false
tags:
  - 逆向工程
  - DeepSeek Harness
  - CSS
  - 主题系统
  - 插件工程化
description: 通过源码溯源还原 DeepSeek Harness Web GUI 的字体 token 体系，用客户端插件覆盖 --dsw-font-family 与 --ds-font-family-code；记录 UA 样式表打断 pre/code 字体继承、第三方插件 token 拼写错误，以及一个导致全部修复静默失效的 CSS 拼接陷阱。
---

# DSH Web GUI 字体覆盖：主题 token 逆向、UA 继承链断裂与一个静默的 CSS 语法陷阱

> **项目类型**：桌面应用主题定制、CSS 层叠分析、插件工程化
> **目标应用**：DeepSeek Harness Desktop 2.0.17（Web GUI，127.0.0.1:43120）
> **版本日期**：2026-09-30
> **成果**：不改安装目录任何文件，通过客户端插件覆盖界面与代码字体；定位并修复三类独立的字体失效原因
> **技术栈**：Node.js、Cordis 插件系统、CSS 自定义属性、Chrome DevTools Protocol、GDI+ 字体度量

---

DSH 的 Web GUI 没有提供字体设置项 —— 设置里只有「外观」和「字号大小」两行，字体族写死在样式表里。本文记录从源码定位字体 token、编写覆盖插件，并排查三类看似相同实则完全无关的字体失效问题的过程。

排查中有多次误判，最终结论与最初假设不同，这些弯路本身比结论更有参考价值，因此保留在文中。

## 一、字体 token 体系

### 1.1 两个核心 token

字体栈定义在 `@deepseek-ai/dsh-client-ui-theme` 的 `lib/client.js:1142`，即注入的 `base.css`：

```css
:root {
  --dsw-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    "Helvetica Neue", Helvetica, Arial, sans-serif;
  --ds-font-family-code: "SF Mono", "JetBrains Mono", "Fira Code", Consolas,
    "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
}
```

两者只差一个字母，但职责完全不同：

| token | 覆盖对象 | 消费点数量 |
|---|---|---|
| `--dsw-font-family` | 正文、标题、表格、菜单、输入框、设置页 | 20 |
| `--ds-font-family-code` | 代码块、行内代码、JSON 视图、终端、diff、ID/版本号 | 24 |

### 1.2 派生 token 的间接引用

字号阶梯 token 以简写形式引用上述两者：

```css
--dsw-font-markdown-code-block: 11px/19px var(--ds-font-family-code);
--dsw-font-markdown-code:       12px/19px var(--ds-font-family-code);
--dsw-font-xs-13:               13px/20px var(--dsw-font-family);
```

由于 `var()` 在使用处求值，**只需覆盖上游两个 token**，全部派生 token 自动跟随，无需逐个处理。

### 1.3 覆盖入口

主题服务暴露 token 覆盖 API（`lib/client.js:1474`）：

```js
ctx.theme.overrideTokens(source, tokens)
```

覆盖层按 seq 次序折入活动快照。`ui-layout` 的 presenter（`lib/client.js:542`）把结果逐个写到 **`document.body` 的内联样式**：

```js
for (const [name, value] of Object.entries(snapshot.active.tokens)) {
  body.style.setProperty(name, value);
}
```

这一点在后续排查中很关键：**token 的最终值在 `body` 的内联样式上，任何选择器规则都无法覆盖它**，只能作用于其后代元素。

### 1.4 覆盖值的形状约束

`validateOverrides`（`lib/client.js:1540`）强制要求 `{ light, dark }` 成对：

```js
if (typeof value === "string") throw new TypeError(
  `theme override "${name}" from "${source}" is a bare string — pass { light: ..., dark: ... }`
);
```

**同一个值也必须重复写两次**，传裸字符串直接抛错。

## 二、插件结构

DSH 客户端插件遵循固定契约（参考官方 `cordis-plugin-development` 技能模板）：

```
dsh-font-override/
├── package.json         dsh.bundle.patch + dsh.client
├── cordis.patch.yml     插入 profile 层栈
├── index.js             Host 半（留空）
└── client.js            客户端半（注入样式表）
```

### 2.1 清单

```json
{
  "name": "dsh-font-override",
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-theme"]
    }
  }
}
```

`client.inject` 声明客户端依赖；`immediately` 使其尽早加载。

### 2.2 客户端半

客户端模块注册进 `window.__ModuleLoader__`，**id 必须等于包名**：

```js
window.__ModuleLoader__.load({
  id: "dsh-font-override",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var UI_STACK   = '"Bad Comic", "FZShaoEr-M11S", "Microsoft YaHei UI", sans-serif';
    var CODE_STACK = '"Cascadia Code", "Cascadia Mono", Consolas, "DingTalk JinBuTi", "Courier New", monospace';

    var inject = ["theme"];

    function apply(ctx) {
      ctx.effect(
        () => ctx.theme.overrideTokens("dsh-font-override", {
          "--dsw-font-family":     { light: UI_STACK,   dark: UI_STACK },
          "--ds-font-family-code": { light: CODE_STACK, dark: CODE_STACK }
        }),
        "dsh-font-override: font tokens"
      );
    }

    exports.name = "dsh-font-override";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
```

### 2.3 DSH 集成

插件需在 profile 清单中注册，仅放入 `node_modules` 不生效：

```json
{
  "dependencies": { "dsh-font-override": "file:./node_modules/dsh-font-override" },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-font-override"],
      "patchReload": "live"
    }
  }
}
```

**`patchReload: "live"` 只对 `cordis.patch.yml` 生效；客户端 JS 变更必须重启 DSH 进程。**

## 三、三类字体失效

三个问题的表现几乎一样（中文显示为微软雅黑），成因完全不同。逐一记录。

### 3.1 UA 样式表打断 pre/code 继承

**现象**：代码块标题栏、复制按钮的字体正确，但代码正文仍是系统默认。

**根因**：浏览器 UA 样式表包含两条**作用在元素自身**的声明：

```css
pre  { font-family: monospace }
code { font-family: monospace }
```

CSS 级联中，元素自身的声明永远优先于继承值。因此只要作用域内出现 `<pre>` 或 `<code>`，其字体即被重置为 `monospace`，父元素设的 `font-family` 完全继承不下去。

不同元素的差异由此产生：

| 元素 | 有 UA 字体规则 | 结果 |
|---|---|---|
| `div` / `span` / `button` | 无 | 正确继承 |
| `pre` / `code` | **有** | 继承被打断 |

这解释了「按钮变了但正文没变」——不是选择器写漏，而是两类元素的级联行为不同。

**修复**：不能只给容器设字体，必须显式覆盖每个 `pre` / `code`：

```css
.md-code-block pre, .md-code-block code,
[data-code-block-content] pre, [data-code-block-content] code,
[data-read] pre, [data-read] code,
[data-diff] pre, [data-diff] code {
  font-family: "Cascadia Code", "Cascadia Mono", Consolas,
    "DingTalk JinBuTi", "Courier New", monospace;
}
```

### 3.2 第三方插件的 token 拼写错误

**现象**：某一个插件自绘的卡片字体始终不跟随。

**根因**：`dsh-agy-link@0.4.42` 把代码字体 token 写错了：

```css
font-family: var(--dsw-font-family-code, ui-monospace, monospace);
/*                      ↑ 多了一个 w */
```

真实 token 是 `--ds-font-family-code`（无 `w`）。核对整个 DSH 代码库：

| token | 定义数 | 消费者 |
|---|---|---|
| `--ds-font-family-code` | 1 | 24 |
| `--dsw-font-family-code` | **0** | 0 |

拼错的名称零定义，`var()` 取不到值，回落到硬编码兜底栈 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` —— 该栈不含中文字形。

受影响的选择器共三个：`.agy-tv-card`（`font-family` 向下继承到标题栏与正文）、`.agy-tv-preview`、`.agy-tv-diff-stat`。

**处置**：未修改其 `dist` 文件（会被插件更新覆盖），而是在样式表中补上别名定义：

```css
:root { --dsw-font-family-code: "Cascadia Code", ... }
```

同时向上游提交 PR：<https://github.com/amlyczz/dsh-agy-link/pull/36>

### 3.3 第三方插件替换了宿主渲染器

排查 3.2 时发现一个意外事实：**每一步 `run_code` 的代码并不是用 DSH 原生组件渲染的**。

`dsh-agy-link` 通过 `tool.call.toolview` 插槽替换了宿主内置的 run_code 代码行渲染器，其源码注释写明：

> The keyed `tool.call.toolview` registration for `run_code` REPLACES the host's built-in code row rather than adding to it.

因此**无论是否在跑 agy**，所有 run_code 调用都渲染成该插件的卡片结构：

```
div.agy-tv-card
  └ pre.agy-tv-card-content    ← UA 规则 pre{font-family:monospace} 命中这里
```

这与 3.1 是同一机制（UA `pre` 规则），但发生在完全不同的容器上，因此需要单独覆盖。

该插件的三个注册点：

| 插槽 | 用途 |
|---|---|
| `tool.call.toolview` | 替换 run_code 代码行渲染 |
| `conversation.session.header.actions` | 会话头按钮 |
| `settings.section` | 设置分区 |

## 四、一个静默的 CSS 语法陷阱

**这是导致前面几轮修复全部无效的原因，也是全文最值得记录的一点。**

样式表由两段拼接，早期写法：

```js
var TECH_CSS = TECH_SCOPE + "{--dsw-font-family:" + CODE_STACK + "}"
  + "," + INHERIT_FIX;          // ← 违规：} 后面跟了一个逗号
```

生成的 CSS：

```css
SEL_A{--dsw-font-family:...},SEL_B{font-family:...}
                            ↑ 逗号使整条规则成为语法错误
```

`SEL_A{...},SEL_B{...}` **不是合法 CSS** —— 逗号只在**同一个选择器组内部**合法，两段规则之间不能有逗号。

浏览器**不报错，直接静默丢弃第二条规则**。对照实验：

```js
'a{color:red},b{font-family:"X"}'   → 解析出 1 条规则，b 消失
'a{color:red}b{font-family:"X"}'    → 解析出 2 条规则
```

后果：`font-family` 那条规则**从未进入样式表**，`pre` 一直停在 UA 的 `monospace`。这也解释了排查中多次出现的 `preRules: []` —— 规则确实不存在，而当时却去怀疑选择器与加载顺序。

**修复**：去掉拼接用的逗号。

```js
var TECH_CSS = TECH_SCOPE + "{--dsw-font-family:" + CODE_STACK + "}"
  + INHERIT_FIX;
```

修复后实测：

```
ruleCount: 3     ← 全部规则在位
matched:   1     ← agy-tv-card 的 pre 命中
font: monospace → "Cascadia Code", "Cascadia Mono", Consolas,
                  "DingTalk JinBuTi", "Courier New", monospace
```

**教训**：拼接 CSS 字符串时，验证对象必须是**解析结果**（`sheet.cssRules.length`），而不是字符串内容。前者能立刻暴露语法错误，后者对语法错误完全无感。

## 五、不可修复的部分

左侧边栏终端使用 xterm，字体由 **JS 选项**指定，CSS 无法触及：

```js
const xterm = new import_xterm.Terminal({
  fontSize: 13,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
});
```

三重障碍：

1. xterm 用 **canvas 绘制**，`font-family` 样式规则对它无效
2. 字体是**构造参数**，不读任何 token
3. xterm 被构建工具**内联打包**进 `client.terminal.js`（非 `require` 载入），无法拦截模块替换构造器

曾尝试拦截 `__ModuleLoader__` 替换 `@xterm/xterm` 导出，核对该文件后确认 xterm 为内联产物（`var require_xterm = __commonJSMin(...)`），该方案不可行，代码已移除。

**结论**：侧边栏终端的中文保持系统默认字体。对话流内的终端块（`TerminalBlock`）走 token，已覆盖。

## 六、字体栈设计

### 6.1 分层依据

界面栈与代码栈采用不同的回落策略：

```css
/* 界面 */
"Bad Comic", "FZShaoEr-M11S", "Microsoft YaHei UI", sans-serif

/* 代码 */
"Cascadia Code", "Cascadia Mono", Consolas, "DingTalk JinBuTi", "Courier New", monospace
```

界面栈按字形回落分层：Bad Comic 命中拉丁，缺失字形落到方正少儿（装饰体），最后以雅黑兜住生僻字。

代码栈**不含非等宽字体**：Bad Comic 与方正少儿均非等宽，用于代码块会导致缩进与 ASCII 表格错位。

### 6.2 全角 CJK 的等宽性验证

钉钉进步体的拉丁部分不等宽，但全角 CJK 等宽。实测（`MeasureString`，20px）：

| 样本 | 宽度 |
|---|---|
| `iiii` | 36.5 |
| `WWWW` | 126.1 |
| `中中中中` | 118.7 |

118.7 = 4 × 29.7，即 CJK 严格等宽。因此把它排在 Cascadia 之后，**只让它接管汉字**，两侧都满足列对齐假设。

### 6.3 字体覆盖范围的验证

检查安装字体的 `cmap` 表，统计 CJK 基本区（U+4E00–U+9FFF）字形数：

| 字体 | 文件大小 | 总字形 | CJK 基本区 |
|---|---|---|---|
| 方正少儿（`FZShaoEr-M11S`） | — | 8,097 | 6,763 |
| 钉钉进步体（`DingTalk JinBuTi`） | 2.0 MB | 7,498 | 6,763 |
| Bad Comic | 310 KB | 783 | 1 |

纯拉丁字体（Bad Comic）中文覆盖为 1，因此**必须**在其后保留中文字体层。

### 6.4 CSS 字体名 ≠ 显示名

CSS 中必须使用字体注册的**家族名**，而非中文显示名：

| 显示名 | CSS 家族名 |
|---|---|
| 方正少儿简体 | `FZShaoEr-M11S` |
| 钉钉进步体 | `DingTalk JinBuTi` |

名称来源为字体文件的 `name` 表（nameID 1/16），可用 GDI+ `InstalledFontCollection` 或直接解析 TTF 获取。

## 七、结论

| 项目 | 状态 |
|---|---|
| 字体 token 体系定位 | 完成 |
| 覆盖 API 与形状约束 | 完成 |
| 客户端插件实现与注册 | 完成 |
| UA `pre`/`code` 继承链修复 | 完成（实测验证） |
| 第三方插件 token 拼写错误 | 完成（已提 PR #36） |
| `agy-tv-card` 容器覆盖 | 完成（实测验证） |
| CSS 拼接语法错误 | 完成（实测验证） |
| 侧边栏 xterm 终端 | **不可修复**（canvas + 内联打包） |

有效修复的实测证据统一为 `getComputedStyle` 前后的对比，而非字符串检查：

```
before: monospace
after : "Cascadia Code", "Cascadia Mono", Consolas, "DingTalk JinBuTi", "Courier New", monospace
```

## 附录 A：源码位置

| 文件 | 作用 |
|---|---|
| `dsh-client-ui-theme/lib/client.js:1142` | `base.css`，两个核心 token 定义 |
| `dsh-client-ui-theme/lib/client.js:1474` | `overrideTokens` API |
| `dsh-client-ui-theme/lib/client.js:1540` | `validateOverrides`，形状约束 |
| `dsh-client-ui-layout/lib/client.js:542` | presenter 把 token 写到 `body` 内联样式 |
| `dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css:97` | `.block :where(pre) code { font: inherit }` |
| `dsh-client-ui-sidebar-terminal/lib/client.terminal.js` | xterm 硬编码 `fontFamily` |
| `dsh-agy-link/dist/client.js` | `tool.call.toolview` 插槽替换 + token 拼写错误 |

## 附录 B：最终样式表

```css
/* 1. 作用域内重绑界面栈 */
[data-code-block-banner], [data-read], [data-diff], [data-terminal],
[data-search], [data-web], .md-code-block, .agy-tv-card {
  --dsw-font-family: "Cascadia Code", "Cascadia Mono", Consolas,
    "DingTalk JinBuTi", "Courier New", monospace;
}

/* 2. 压过 UA 的 pre/code 规则 */
.md-code-block pre, .md-code-block code,
[data-code-block-content] pre, [data-code-block-content] code,
[data-read] pre, [data-read] code,
.agy-tv-card pre, .agy-tv-card code,
.agy-tv-card-content, .agy-tv-card-content * {
  font-family: "Cascadia Code", "Cascadia Mono", Consolas,
    "DingTalk JinBuTi", "Courier New", monospace !important;
}

/* 3. 兼容第三方插件的拼写错误 */
:root { --dsw-font-family-code: "Cascadia Code", ... }
```

> 注意第 1、2、3 段之间**不能有逗号** —— 见第四章。

## 附录 C：排查工具

```js
// 列出某元素命中的全部 font-family 规则
(() => {
  const el = document.querySelector('pre');
  const rules = [...document.styleSheets]
    .flatMap(s => { try { return [...s.cssRules] } catch { return [] } });
  return rules
    .filter(r => r.selectorText && r.style && r.style.fontFamily)
    .filter(r => { try { return el.matches(r.selectorText) } catch { return false } })
    .map(r => r.selectorText.slice(0, 60) + ' => ' + r.style.fontFamily.slice(0, 45));
})()
```

```powershell
# 列出本机字体家族名
Add-Type -AssemblyName System.Drawing
[System.Drawing.Text.InstalledFontCollection]::new().Families.Name | Sort-Object
```

## 附录 D：参考资料

- DeepSeek Harness 官方插件开发技能：`cordis-plugin-development`
- 上游 PR：<https://github.com/amlyczz/dsh-agy-link/pull/36>
- CSS 层叠规范（继承与 UA 样式表优先级）：<https://www.w3.org/TR/CSS22/cascade.html>
