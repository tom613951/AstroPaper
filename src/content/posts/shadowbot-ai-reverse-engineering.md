---
author: tom613951
pubDatetime: 2026-07-14T12:00:00Z
title: 影刀 RPA (ShadowBot) AI 模型逆向替换全纪实
postSlug: shadowbot-ai-reverse-engineering
featured: true
draft: false
tags:
  - RPA
  - 逆向工程
  - ShadowBot
  - Hook
description: 本文记录了通过 CDP 注入 JS Hook，将影刀 RPA 内置加密 AI 替换为自定义 Gemini API，实现完全控制 AI 行为、System Prompt 和工具定义的逆向替换全过程。
---

# 影刀 RPA (ShadowBot) AI 模型逆向替换全纪实

> **项目类型**：桌面应用逆向工程 + 运行时注入
> **目标软件**：影刀 RPA (ShadowBot) v6.2.21，.NET 6.0 WPF 桌面 RPA 平台
> **最终成果**：通过 CDP 注入 JS Hook，将影刀内置加密 AI 替换为自定义 Gemini API，实现完全控制 AI 行为、System Prompt 和工具定义
> **技术栈**：dnSpy, Chrome DevTools Protocol, CefSharp, Node.js, RSA/AES-GCM 加密分析

---

## 目录

1. [项目背景与目标](#1-项目背景与目标)
2. [第一阶段：dnSpy 静态反编译](#2-第一阶段dnspy-静态反编译)
3. [第二阶段：发现 CefSharp 内嵌浏览器](#3-第二阶段发现-cefsharp-内嵌浏览器)
4. [第三阶段：JavaScript 加密逻辑逆向](#4-第三阶段javascript-加密逻辑逆向)
5. [第四阶段：Hook 方案设计与实现](#5-第四阶段hook-方案设计与实现)
6. [第五阶段：CDP 注入机制](#6-第五阶段cdp-注入机制)
7. [第六阶段：Linux 服务器代理部署（已废弃）](#7-第六阶段linux-服务器代理部署已废弃)
8. [第七阶段：工具调用无限循环问题](#8-第七阶段工具调用无限循环问题)
9. [第八阶段：持久化与开机自启](#9-第八阶段持久化与开机自启)
10. [最终架构](#10-最终架构)
11. [完整文件清单](#11-完整文件清单)
12. [使用指南](#12-使用指南)
13. [踩坑汇总表](#13-踩坑汇总表)
14. [后续维护与检查](#14-后续维护与检查)

---

## 1. 项目背景与目标

影刀 RPA (ShadowBot) 是一款国产桌面 RPA 平台，支持通过 AI 对话自动生成自动化流程。其内置 AI 模型经过服务端加密，用户无法自定义模型、修改 System Prompt 或调整工具定义。

**核心目标**：

- 替换影刀内置 AI 为自定义 Gemini API（免费额度）
- 完全控制 System Prompt，定制 AI 行为
- 自定义工具（Tool）定义和参数格式
- 实现开机自动启动，无需手动操作
- 不修改影刀原始文件，仅运行时注入

---

## 2. 第一阶段：dnSpy 静态反编译

### 2.1 初步探查

影刀安装路径为 `C:\Program Files\ShadowBot\shadowbot-6.2.21\`。通过 `dnSpy.Console.exe` 反编译关键 DLL：

```bash
# 导出整个 DLL 为 C# 项目
D:\dnSpy-net-win64\dnSpy.Console.exe -o <output_dir> <dll_path> --no-sln

# 反编译指定类到 stdout
D:\dnSpy-net-win64\dnSpy.Console.exe -t <TypeName> <dll_path>

# 切换 IL 语言模式
D:\dnSpy-net-win64\dnSpy.Console.exe -l IL <dll_path>
```

### 2.2 关键 DLL 识别

通过分析 .pdb 调试符号和类型引用关系，定位了四个核心 DLL：

| DLL | 职责 |
|-----|------|
| `Components.dll` | `ChatGPTApi` 实现 + `ApiClient` + `ExecuteWithSignAsync` 签名请求 |
| `Components.Protocol.dll` | `IChatGPTApi` 接口定义 + RSA 加密字段 |
| `Shell.Development.dll` | `MagicFlowChatViewModel`（AI 对话视图模型）+ `SkillStorage` |
| `Runtime.Development.dll` | `IWebExecuter` + CefSharp 桥接 |

### 2.3 RSA 加密字段发现

在 `Components.Protocol.dll` 中找到 `IChatGPTApi` 接口，其中包含一个名为 `ni8sFJYE3` 的字段——这是一个 RSA 公钥的存储位置。同类的 `fqro0HjUtL` 方法实为 `VirtualAlloc`（内存分配），并非 RSA 相关。

进一步追踪发现混淆类 `WqvWUdBjXjZdpSFeKY`，尝试在其中搜索 `.rQfKQy2FK` 方法或 `Encrypt`/`Decrypt` 关键词。

### 2.4 挫折：运行时混淆

dnSpy 反编译结果中，关键方法体（如 `ChatGPTApi.GetChatSolutionAsync`）**全部显示为 `nop`**——方法体被 `COJKMRMmH4()` 在运行时动态解密。静态分析只能看到空操作码，无法获取真实逻辑。

### 2.5 dnSpy GUI 运行时调试

尝试用 dnSpy GUI 附加到进程进行运行时调试：

1. 引擎选择 `.NET Core`（非 Framework）
2. 工作目录设为 exe 根目录（`C:\Program Files\ShadowBot\shadowbot-6.2.21\`），而非版本子目录
3. `ShadowBot.exe` 是启动器，`ShadowBot.Shell.exe` 是 UI 主进程——需要附加到后者
4. "启动可执行文件" 方式会遇到 CoreCLR 超时
5. 改用 "附加到进程" (Attach to Process)

**关键发现**：运行时下断点后，观察到 `ChatGPTApi.GetChatSolutionAsync` 的 C# 代码中调用了 `RestSharp` 发送 HTTP 请求——但实际网络抓包显示 AI 请求并非来自 C# RestSharp，而是来自 **CefSharp 内嵌浏览器**的 JavaScript。

### 2.6 关键转折：C# 调用链是假线索

通过 Reqable 抓包确认：

- C# 侧的 `ChatGPTApi.GetChatSolutionAsync` **仅供非 AI 流程使用**（如技能加载等）
- **实际 AI 请求由 CefSharp 内嵌浏览器的 JavaScript 发起**，User-Agent 为 `Chrome/106`，Origin 为 `http://local.shadowbot.com`
- 请求端点：`POST api.winrobot360.com/api/v1/ai/chat/tools/vision/stream/message`

这意味着 dnSpy 反编译 C# 代码的方向走不通——真正的加密逻辑在 **前端 JavaScript** 中。

---

## 3. 第二阶段：发现 CefSharp 内嵌浏览器

### 3.1 CefSharp 调试端口

影刀使用 CefSharp（Chromium Embedded Framework）作为内嵌浏览器。通过启动参数或环境变量，CefSharp 暴露了 **远程调试端口 8087**，支持 Chrome DevTools Protocol (CDP)。

访问 `http://localhost:8087/json` 可获取所有 CefSharp 页面列表，包括页面 ID、URL 和 WebSocket 调试 URL。

### 3.2 前端资源定位

影刀的前端资源打包在 `web.pak`（45MB 自定义加密格式）中。解包后发现主入口为 `index.7709827fff35aa8bcac6.js`，所有 AI 加密逻辑都在此文件中。

---

## 4. 第三阶段：JavaScript 加密逻辑逆向

### 4.1 加密函数 `q` 定位

在 `index.7709827fff35aa8bcac6.js` 中搜索 AI 请求路径关键词，定位到函数 `q`，该函数负责完整的加密流程。

### 4.2 完整加密链路

通过分析 `q` 函数及其依赖，还原出完整的加密流程：

```
1. 生成 32 字节随机 AES-256 密钥
2. 从五行算法名（metal/wood/water/fire/earth）中随机选择一个
3. 用对应的 RSA 公钥加密 AES 密钥
4. 用 AES 密钥以 AES-GCM 模式加密消息（IV 为 12 字节随机，tagLength=128）
5. 构建请求体：{ messages: <AES密文>, encryptKey: <RSA密文>, crypt: <算法名>, iv: <IV> }
```

### 4.3 五个 RSA 公钥

`k` 对象存储了 5 个 RSA 公钥，对应五行算法名。公钥以 ASCII 码数组形式存储，通过 `P()` 函数解码为 base64，再转换为 PEM 格式。

```javascript
// 伪代码
const k = {
    metal: [45, 78, ...],  // ASCII 码数组 → PEM 公钥
    wood: [...],
    water: [...],
    fire: [...],
    earth: [...]
};
```

### 4.4 依赖库识别

- `j = n(22079)` → node-forge 库（加密操作）
- `T = n(56084)` → JSBN 库（RSA 加密实例）
- `S = new T.X` → RSA 加密实例

### 4.5 响应不加密

关键发现：AI 响应为 **明文 SSE（Server-Sent Events）**，采用 OpenAI 兼容格式，不经过加密。这意味着只需替换请求路径和请求体，响应可以直接透传。

### 4.6 替代方案评估

分析了三种替代方案：

| 方案 | 描述 | 可行性 |
|------|------|--------|
| A. SDK markdown 自建 AI 服务 | 在影刀外部搭建 | 偏离目标，无法集成到 AI 对话流 |
| B. 替换 RSA 公钥 | 替换 k 中的公钥 + 运行代理解密 | 复杂，需同时处理加密和解密 |
| C. 浏览器内 Hook | Hook fetch/JSON.stringify 拦截明文 | **最优方案**——最简单、最直接 |

最终选择 **方案 C**：通过 CDP 注入 JS Hook，在加密前捕获明文，在请求发送前替换目标地址和请求体。

---

## 5. 第四阶段：Hook 方案设计与实现

### 5.1 Hook 架构

Hook 分为两步：

**第一步：Hook `JSON.stringify`**
- 检测传入参数是否为数组且首元素含 `role` 字段
- 若是，则捕获明文 `messages` 并存储到全局变量 `lastMessages`
- 不修改原始行为，仅旁路监听

**第二步：Hook `window.fetch`**
- 检测请求 URL 是否为 `/api/v1/ai/chat/tools/vision/stream/message`
- 若是，使用捕获的明文 `messages` + 自定义 System Prompt + 自定义 Tool 定义
- 重新构建请求，发送到 Gemini API
- 返回 Response 对象给影刀的 stream reader

### 5.2 System Prompt 定制

替换原始 System Prompt 为自定义版本，定义 AI 角色、可用工具、工作流和代码规范：

```javascript
const SYSTEM_PROMPT = `You are an AI assistant integrated into ShadowBot...
## Available Tools
1. load_skill(skill_name) - Load a skill package...
2. execute_skill_tool(skill_name, method, explanation, params)...
3. commit_code_patch(patch)...
...
## Code Conventions
### Build Contract
- SDK signatures must come from SDK references, not from inference...
### Web Core Rules
- Import: "from xbot_playwright.sync_api import sync_playwright"...
`;
```

### 5.3 工具（Tool）定义

定义了 7 个工具，完全控制 AI 可用的工具集和参数格式：

1. `load_skill` - 加载技能包文档
2. `execute_skill_tool` - 执行技能方法
3. `commit_code_patch` - 提交最终代码
4. `enter_mode` - 切换模式
5. `task_done` - 完成任务信号
6. `read_file_data` - 读取文件
7. `ask_user_question` - 向用户提问

### 5.4 Provider 配置与切换

设计了多 Provider 架构，支持运行时切换：

```javascript
const PROVIDERS = {
    gemini: {
        name: 'Gemini',
        apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKey: '<API_KEY>',
        model: 'gemini-3.1-flash-lite',
        authHeader: 'Authorization',
        authPrefix: 'Bearer '
    },
    gemini_flash: {
        name: 'Gemini Flash',
        apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKey: '<API_KEY>',
        model: 'gemini-3.5-flash',
        authHeader: 'Authorization',
        authPrefix: 'Bearer '
    }
};
```

运行时控制 API：
- `window.__aiHook.getStatus()` - 查看当前状态
- `window.__aiHook.switchProvider('gemini_flash')` - 切换 Provider
- `window.__aiHook.disable()` - 临时禁用 Hook
- `window.__aiHook.setModel('gemini-3.5-flash')` - 切换模型

### 5.5 429 限流重试

在 Hook 内置了 429 重试逻辑（3 次指数退避）：

```javascript
while (retryCount <= maxRetries) {
    response = await origFetch.call(window, P.apiUrl, {
        method: 'POST', headers: headers,
        body: origStringify.call(JSON, aiRequest)
    });
    if (response.status === 429 && retryCount < maxRetries) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
        const waitMs = (retryAfter * 1000) + (retryCount * 1000);
        await new Promise(r => setTimeout(r, waitMs));
        retryCount++;
        continue;
    }
    break;
}
```

### 5.6 CORS 无需代理

Gemini API (`generativelanguage.googleapis.com`) 支持 CORS，从 `http://local.shadowbot.com` Origin 发起的跨域请求可直接通过，无需代理服务器。

---

## 6. 第五阶段：CDP 注入机制

### 6.1 CDP 协议基础

Chrome DevTools Protocol (CDP) 通过 WebSocket 通信。流程：

1. `GET http://localhost:8087/json` 获取页面列表
2. 从列表中找到目标页面的 `webSocketDebuggerUrl`
3. 建立 WebSocket 连接
4. 发送 `Runtime.evaluate` 命令，参数为 `eval(atob("base64编码的Hook代码"))`
5. 检查返回值确认注入成功

### 6.2 注入器实现

> **注**：此节描述的 `inject_hook_auto.js` 已被合并到 `hook_server.js` 中，以下为开发过程历史记录。

`inject_hook_auto.js` 实现了完整的注入流程：

```javascript
// 1. 获取页面列表
const pagesResp = await fetch('http://localhost:8087/json');
const pages = await pagesResp.json();

// 2. 找到 ShadowBot 页面或浏览器级 CDP
const target = pages.find(p => p.type === 'page')
             || pages.find(p => p.type === 'browser');

// 3. 通过 WebSocket 发送 Runtime.evaluate
const ws = new WebSocket(target.webSocketDebuggerUrl);
ws.onopen = () => {
    ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
            expression: `eval(atob("${b64Code}"))`,
            returnByValue: true
        }
    }));
};
```

### 6.3 Base64 编码陷阱

**问题**：PowerShell 的 `[Convert]::ToBase64String()` 对含中文字符的 JS 代码进行编码后，CefSharp 的 `atob()` 解码时出现 `SyntaxError`。

**原因**：PowerShell 默认使用 .NET 字符串编码，与 CefSharp 浏览器期望的 UTF-8 编码不一致，导致多字节字符被错误拆分。

**修复**：使用 Node.js 的 `Buffer` 进行编码，确保 UTF-8 一致性：

```javascript
// encode_b64.js
const fs = require('fs');
const content = fs.readFileSync(__dirname + '/ai_hook.js', 'utf8');
const b64 = Buffer.from(content, 'utf8').toString('base64');
fs.writeFileSync(__dirname + '/ai_hook_b64.txt', b64, 'utf8');
```

### 6.4 WebSocket 客户端选型

**Python websocket-client 失败**：Windows WinError 10013（网络权限策略阻止 Python 的 websocket 库绑定端口）。

**Node.js v26+ 内置 WebSocket 成功**：`globalThis.WebSocket` 是 Node.js v26+ 原生实现，无权限问题。

### 6.5 Hook 重注入问题

> **注**：以下描述的 `clear_hook.js` 已被 `hook_server.js` 内置的 `uninstall()` 调用替代。以下为开发过程历史记录。

**问题**：Hook 安装时设置 `window.__aiHookInstalled = true` 标志。重新注入时，Hook 检测到此标志直接跳过，导致新版本代码不生效。

**修复**：创建 `clear_hook.js`，在注入前通过 CDP 清除标志：

```javascript
// 先清除旧 Hook
ws.send(JSON.stringify({
    method: 'Runtime.evaluate',
    params: {
        expression: 'window.__aiHookInstalled = false; window.__aiHook = null;'
    }
}));
// 然后注入新 Hook
```

> **演进**：`hook_server.js` 现在在重注入前调用 `window.__aiHook.uninstall()`，该方法会恢复原始的 `JSON.stringify` 和 `window.fetch`，再清除标志，确保不会产生包装链。

### 6.6 页面刷新导致 Hook 丢失

> **注**：以下描述的 `hook_monitor.js` 已被合并到 `hook_server.js` 中。以下为开发过程历史记录。

**问题**：用户新建影刀流程时，CefSharp 页面会刷新，page ID 发生变化，所有已注入的 Hook 随之销毁。

**修复**：创建 `hook_monitor.js` 后台监控脚本，每 5 秒轮询 CDP 页面列表，检测 page ID 变化后自动重新注入：

```javascript
// hook_monitor.js 核心逻辑
setInterval(async () => {
    const resp = await fetch('http://localhost:8087/json');
    const pages = await resp.json();
    const page = pages.find(p => p.type === 'page');

    if (page && page.id !== lastPageId) {
        if (lastPageId !== null) {
            console.log(`Page changed: ${lastPageId} → ${page.id}, re-injecting...`);
            await clearAndInject();
        }
        lastPageId = page.id;
    }
}, 5000);
```

---

## 7. 第六阶段：Linux 服务器代理部署（已废弃）

> **注意**：此阶段方案最终被直连 Gemini API 替代，但作为逆向过程中的重要尝试，完整记录于此。

### 7.1 动机

最初担心 CefSharp 内嵌浏览器的 CORS 限制会阻止直连 Gemini API，因此在 Linux 服务器（115.29.143.52）部署代理。

### 7.2 代理实现

`gemini_proxy.js` 部署在 Linux 服务器，监听 8080 端口：

- 转发请求到 Gemini API
- 429 重试（3 次指数退避）
- 本地限速（14 RPM，匹配免费额度）
- CORS 头注入
- SSE 流式透传

### 7.3 阿里云安全组封锁

**问题**：阿里云安全组封锁了 80 和 8080 端口的外部访问，即使 UFW 已放行。

**修复**：使用 SSH 本地端口转发绕过（端口 22 未封锁）：

```powershell
ssh -L 8080:localhost:8080 -N -i C:\Users\26503\.ssh\id_ed25519 root@115.29.143.52
```

### 7.4 服务器无法直连 Google API

**问题**：Linux 服务器位于中国，无法直接访问 `generativelanguage.googleapis.com`。

**修复**：代理代码通过 mihomo（Clash，`127.0.0.1:7890`）的 HTTP CONNECT 隧道 + TLS 包装访问 Google API：

```javascript
// HTTP CONNECT 隧道建立
const req = http.request({
    host: '127.0.0.1', port: 7890,
    method: 'CONNECT',
    path: 'generativelanguage.googleapis.com:443'
});
// CONNECT 成功后，在 socket 上包装 TLS
const tlsSocket = tls.connect({ socket: socket, servername: hostname });
// 通过 TLS socket 发送 HTTPS 请求
```

Node.js 内置 `https.request` 不会自动走 HTTP 代理，需手动实现 CONNECT 隧道。

### 7.5 ERR_HTTP_HEADERS_SENT 崩溃

**问题**：请求超时后，代理尝试调用 `sendSseError()` 返回错误，但 SSE 流式响应的 headers 已发送，导致 `ERR_HTTP_HEADERS_SENT` 崩溃。

**修复**：在 `sendSseError` 和 `sendJson` 中添加 `headersSent` 检查：

```javascript
function sendSseError(res, message) {
    if (res.headersSent) {
        // headers 已发送，只能通过 stream 发送错误
        res.write(`data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`);
        try { res.end(); } catch(_) {}
        return;
    }
    // 正常发送错误响应
    res.writeHead(200, { 'Content-Type': 'text/event-stream', ... });
    res.end(body);
}
```

### 7.6 弃用决策

验证发现 Gemini API 完全支持 CORS，从 `http://local.shadowbot.com` Origin 发起的跨域请求直接通过。因此无需服务器代理，改为直连方案。

服务器上仍保留了 systemd 服务 `gemini-proxy.service`，可通过以下命令停用：

```bash
systemctl stop gemini-proxy
systemctl disable gemini-proxy
```

---

## 8. 第七阶段：工具调用无限循环问题

### 8.1 现象

正常聊天没问题，但让 AI 搭建 RPA 流程时，出现持续返回相同响应的无限循环。影刀界面不断显示 "加载技能中..." 但始终失败。

### 8.2 抓包分析

通过 CDP 读取网络请求，发现 AI 反复调用 `load_skill` 工具，但每次都被影刀后端拒绝，错误信息为：

```
Error: Invalid arguments for "load_skill" tool:
Field 'skill_name' is required and cannot be empty.
```

### 8.3 根因：camelCase vs snake_case

Hook 中定义的工具参数使用 **camelCase**（如 `skillName`、`filePath`），但影刀后端期望 **snake_case**（如 `skill_name`、`file_path`）。

AI 根据 Hook 中的工具定义发送 camelCase 参数 → 影刀后端解析失败 → 返回错误 → AI 重试相同的调用 → 无限循环。

### 8.4 遗漏的 reasoning_trace 字段

更深入分析发现，影刀的工具 schema 中有一个 `reasoning_trace` 字段：

- 类型：`string`
- 描述：`中文必填。自上一步起至决定拉取该 skill 文档为止的完整推理过程...`
- 在 schema 的 `required` 数组中**未列出**，但描述标注为 `中文必填`
- 实际运行时**必须填写**，否则影刀后端拒绝

### 8.5 修复

更新所有工具定义为 snake_case 并添加 `reasoning_trace`：

```javascript
const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'load_skill',
            description: 'Load a skill package...',
            parameters: {
                type: 'object',
                properties: {
                    reasoning_trace: {
                        type: 'string',
                        description: '中文必填。自上一步起至决定拉取该 skill 文档为止的完整推理过程...'
                    },
                    skill_name: {
                        type: 'string',
                        description: 'The name of the skill to be executed.'
                    }
                },
                required: ['skill_name']
            }
        }
    },
    // execute_skill_tool: skill_name, method, explanation, params, reasoning_trace
    // commit_code_patch: patch, reasoning_trace
    // enter_mode: mode, explanation, reasoning_trace
    // task_done: summary, reasoning_trace (required: [])
    // read_file_data: file_path, reasoning_trace
    // ask_user_question: question, reasoning_trace
];
```

### 8.6 影刀报错即文档

影刀后端在工具调用失败时，错误消息中会返回**正确的 schema 协议**（`schema protocol: {...}`）。这相当于影刀自带了 API 文档——每次失败都能从错误中学习正确的参数格式。

---

## 9. 第八阶段：持久化与开机自启

### 9.1 方案选型

| 方案 | 可行性 | 问题 |
|------|--------|------|
| Windows 计划任务 (schtasks) | ❌ | 需要管理员权限 |
| 复制到 Startup 文件夹 | ❌ | cp/PowerShell 操作到 Startup 路径会超时 |
| 注册表 Run 键 | ✅ | HKCU 下无需管理员权限 |

### 9.2 注册表 Run 键

创建 `.reg` 文件导入到 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`：

```reg
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run]
"ShadowBotAIHook"="powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File \"C:\\Users\\26503\\.qoderworkcn\\workspace\\mrkeavpv1hke4qm4\\shadowbot_hook_startup.ps1\""
```

导入命令（无需管理员）：

```cmd
reg import add_startup.reg
```

### 9.3 启动脚本

`shadowbot_hook_startup.ps1` 最终简化版：

```powershell
$WORK_DIR = $PSScriptRoot
while ($true) {
    $monitorProcess = Start-Process -FilePath "node" `
        -ArgumentList "$WORK_DIR\hook_server.js" `
        -PassThru -WindowStyle Hidden
    $monitorProcess.WaitForExit()
    Start-Sleep -Seconds 3
}
```

启动流程：

1. Windows 开机 → 注册表 Run 键触发 PowerShell 脚本
2. PowerShell 启动 `hook_server.js`（Node.js 后台进程）
3. `hook_server.js` 每 5 秒轮询 CDP 端口 8087
4. 检测到 CefSharp 就绪后注入 Hook
5. 持续监控 page ID 变化，自动重注入（含 uninstall() 恢复）
6. 同时提供 Web 配置面板（http://127.0.0.1:3000）和配置持久化
7. 若 Node 进程崩溃，PowerShell 循环自动重启

### 9.4 早期启动脚本（完整版）

早期版本 `shadowbot_hook_startup.ps1` 包含 SSH 隧道建立（已废弃）和更复杂的逻辑。最终简化为仅运行 `hook_server.js` + 崩溃自动重启。

---

## 10. 最终架构

```
┌─────────────────────────────────────────────────────────┐
│  Windows 开机                                            │
│    └─ 注册表 HKCU\...\Run                               │
│         └─ powershell.exe -File shadowbot_hook_startup  │
│              └─ node hook_server.js (后台运行)           │
│                   ├─ 每5秒轮询 localhost:8087/json       │
│                   ├─ 检测 CefSharp 页面就绪              │
│                   ├─ 检测 page ID 变化                  │
│                   └─ 变化时重新注入 ai_hook.js          │
│                                                         │
│  ┌──────────────────────────────────────────────┐       │
│  │  影刀 ShadowBot (CefSharp, port 8087)       │       │
│  │                                              │       │
│  │  ┌──────────────────────────────────────┐   │       │
│  │  │  注入的 ai_hook.js                   │   │       │
│  │  │                                      │   │       │
│  │  │  1. JSON.stringify Hook              │   │       │
│  │  │     └─ 捕获明文 messages              │   │       │
│  │  │                                      │   │       │
│  │  │  2. fetch Hook                       │   │       │
│  │  │     ├─ 拦截 /ai/chat/.../stream       │   │       │
│  │  │     ├─ 用明文+自定义Prompt重建请求    │   │       │
│  │  │     ├─ 直连 Gemini API (CORS支持)     │   │       │
│  │  │     ├─ 429自动重试(3次指数退避)       │   │       │
│  │  │     └─ 返回SSE流给影刀 stream reader  │   │       │
│  │  │                                      │   │       │
│  │  │  3. 控制API                          │   │       │
│  │  │     ├─ window.__aiHook.getStatus()    │   │       │
│  │  │     ├─ .switchProvider()             │   │       │
│  │  │     ├─ .setModel()                   │   │       │
│  │  │     ├─ .uninstall()                   │   │       │
│  │  │     └─ .disable()                    │   │       │
│  │  └──────────────────────────────────────┘   │       │
│  └──────────────────────────────────────────────┘       │
│                                                         │
│  直连 https://generativelanguage.googleapis.com          │
│  /v1beta/openai/chat/completions                        │
│  (无需代理服务器，Gemini支持CORS)                        │
└─────────────────────────────────────────────────────────┘
```

**关键特性**：

- 零修改影刀原始文件
- 运行时注入，影刀更新后可能需要适配
- 直连 Gemini API，无需中间服务器
- 429 限流自动重试
- 页面刷新自动重注入
- 开机自动启动
- 运行时可切换 Provider 和模型

---

## 11. 完整文件清单

> **注意**：以下为当前最终文件清单。开发过程中使用过的 `inject_hook_auto.js`、`hook_monitor.js`、`clear_hook.js`、`check_hook_status.js`、`cors_test_monitor.js` 等脚本已全部合并到 `hook_server.js` 中并删除。下文各节中提及 these 旧脚本的内容为历史记录，仅供理解开发过程之用。

| 文件 | 用途 | 说明 |
|------|------|------|
| `ai_hook.js` | 主 Hook 脚本 | 注入到 CefSharp 浏览器的核心代码，含 Provider 配置、System Prompt、工具定义、JSON.stringify/fetch Hook、uninstall() 恢复 |
| `hook_server.js` | 统一服务端 | 合并了 CDP 监控 + Web 配置面板 + 配置持久化，每 5 秒轮询自动重注入，替代了旧的注入器/监控器/清除脚本 |
| `config_panel.html` | Web 配置面板 | GitHub 风格中文界面，跟随系统主题，提供 API 配置和实时状态 |
| `encode_b64.js` | Base64 编码器 | 使用 Node.js Buffer 对 ai_hook.js 进行 UTF-8 安全的 base64 编码 |
| `shadowbot_hook_startup.ps1` | Windows 启动脚本 | 被注册表 Run 键调用，启动并守护 hook_server.js |
| `add_startup.reg` | 注册表导入文件 | 将启动脚本注册到 HKCU Run 键，无需管理员权限 |
| `install.bat` | 一键安装脚本 | 检查 Node.js、编码 Hook、启动服务、打开浏览器 |
| `ai_hook_b64.txt` | 编码后的 Hook | base64 编码的 ai_hook.js，供 hook_server.js 读取 |
| `hook_config.json` | 配置持久化 | 保存用户的 API 地址、密钥、模型、认证头配置 |

---

## 12. 使用指南

### 12.1 首次部署

```bash
# 1. 编码 Hook 脚本
node encode_b64.js

# 2. 确保影刀已运行，CefSharp 端口可用
# 访问 http://localhost:8087/json 确认

# 3. 启动服务（含自动注入、监控、Web 面板）
node hook_server.js

# 4. 打开浏览器配置 API
# 访问 http://localhost:3000
```

或直接运行一键安装：

```cmd
install.bat
```

### 12.2 开机自启

```cmd
# 导入注册表（一次性操作，需将 add_startup.reg 中路径改为实际路径）
reg import add_startup.reg
```

### 12.3 日常使用

正常打开影刀即可。hook_server.js 每 5 秒轮询 CDP，检测到影刀页面后自动注入 Hook。

### 12.4 运行时控制

通过 Web 面板（http://localhost:3000）可视化配置，或在影刀 CefSharp 控制台执行：

```javascript
window.__aiHook.getStatus()              // 查看当前状态
window.__aiHook.switchProvider('custom')  // 切换到自定义 Provider
window.__aiHook.setModel('gemini-3.5-flash')    // 切换模型
window.__aiHook.disable()                // 临时禁用
window.__aiHook.uninstall()              // 完全卸载（恢复原始函数）
```

### 12.5 更新 Hook 后

修改 `ai_hook.js` 后需要重新编码，然后关闭并重新打开影刀的 AI 对话页面触发自动重注入：

```bash
node encode_b64.js          # 重新编码
# 然后在影刀中关闭 AI 对话再重新打开，hook_server.js 会自动检测 page ID 变化并重新注入
```

### 12.6 停用

```cmd
# 移除开机自启
reg delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v ShadowBotAIHook /f

# 停止服务
# 在任务管理器中结束 node.exe (hook_server.js) 进程
```

---

## 13. 踩坑汇总表

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | dnSpy 反编译方法体全为 nop | 运行时混淆（COJKMRMmH4 动态解密） | 改用 GUI 运行时下断点 |
| 2 | C# ChatGPTApi 不是 AI 请求来源 | C# 仅供非 AI 流程，AI 请求来自 CefSharp JS | 转向前端 JS 逆向 |
| 3 | Python websocket WinError 10013 | Windows 网络权限策略阻止 Python 绑定 | 改用 Node.js v26+ 内置 WebSocket |
| 4 | 阿里云安全组封锁 80/8080 | 云安全组规则，非 UFW | SSH 本地端口转发（端口 22 未封锁） |
| 5 | Linux 服务器无法访问 Google API | 中国网络环境 | mihomo HTTP CONNECT 隧道 + TLS 包装 |
| 6 | ERR_HTTP_HEADERS_SENT 崩溃 | 超时后尝试发送错误但 headers 已发出 | 添加 res.headersSent 检查 |
| 7 | schtasks 需要管理员权限 | UAC 限制 | 改用注册表 HKCU Run 键 |
| 8 | 复制文件到 Startup 超时 | 不明（可能是 Windows 特殊路径保护） | 改用注册表方案 |
| 9 | 工具调用无限循环 | camelCase vs snake_case + 缺少 reasoning_trace | 修正所有工具参数为 snake_case |
| 10 | PowerShell base64 导致 SyntaxError | .NET 与 CefSharp UTF-8 编码不一致 | 使用 Node.js Buffer.toString('base64') |
| 11 | Hook 重注入不生效 | __aiHookInstalled 标志阻止重装 | ~~创建 clear_hook.js 先清除标志~~ 现由 hook_server.js 在重注入前调用 uninstall() 恢复原始函数 |
| 12 | 新建流程后 Hook 丢失 | CefSharp 页面刷新，page ID 变化 | ~~hook_monitor.js 后台轮询~~ 现由 hook_server.js 每 5 秒轮询自动检测 page ID 变化并重注入 |
| 13 | 服务器代理方案复杂 | 多层代理（SSH→mihomo→TLS） | 发现 Gemini 支持 CORS，改为直连 |

---

## 14. 后续维护与检查

本节记录项目完成后的安全加固、代码质量修复和已知限制，供后续维护参考。

### 14.1 安全加固（P0）

**API Key 暴露面收敛**

项目初期 API Key 硬编码在多个文件中（`hook_server.js` 的 `DEFAULT_CONFIG`、`cors_test_monitor.js` 等）。修复后：

- `hook_server.js` 的 `DEFAULT_CONFIG` 所有字段为空字符串，密钥仅存在于 `hook_config.json`
- `GET /api/config` 返回掩码密钥（`****XXXX` 格式，只显示后 4 位）
- `POST /api/config` 提交值为空或掩码格式时保留原密钥，不清空
- `cors_test_monitor.js`（含明文密钥的测试脚本）已删除
- 分发时 `ai_hook.js` 中 `PROVIDERS` 各项的 `apiKey` 均为空字符串，密钥由 `hook_server.js` 在注入后通过 CDP 下发

**本地管理面封闭**

初期 `hook_server.js` 绑定 `0.0.0.0:3000`（所有网络接口）并设置 `Access-Control-Allow-Origin: *`，任意网站可通过 fetch 读取或修改配置。修复后：

- 服务器绑定 `127.0.0.1` 仅，外部网络无法访问
- 移除所有 CORS 响应头，同源策略阻止跨域请求
- `gemini_proxy.js`（绑定 `0.0.0.0`、CORS `*`、无认证、携带密钥）已删除

**CDP 注入表达式安全**

初期 `buildApplyExpr` 使用单引号转义构造 CDP 表达式：`setApiKey('${value.replace(/'/g, "\\'")}')`，无法正确处理反斜杠，攻击者可通过精心构造的值突破引号上下文注入任意 JS。修复后改用 `JSON.stringify(value)` 构造所有参数，JSON 序列化天然处理引号、反斜杠和 Unicode，杜绝注入。

### 14.2 代码质量修复（P1）

**authHeader / authPrefix 配置链修复**

存在三个关联问题：

1. 前端 `config_panel.html` 的 `loadConfig` 使用 `if (cfg.authPrefix)` 真值检查，空字符串被跳过，输入框回退到 HTML 默认值 `Bearer `
2. 前端 `apply` handler 使用 `value || 'Bearer '`，用户清空前缀后提交仍被替换为 `Bearer `
3. 后端 `hook_server.js` 的 `POST /api/config` 和 `buildApplyExpr` 同样使用 `||` 逻辑

修复方案：全链路改用 `Object.prototype.hasOwnProperty`（后端）和 `!== undefined` 三元判断（前端/`buildApplyExpr`）区分"字段不存在"（用默认值）和"字段为空字符串"（用空值）。具体改动：

- `config_panel.html` `loadConfig`：`cfg.authPrefix !== undefined ? cfg.authPrefix : 'Bearer '`
- `config_panel.html` `apply`：`authPrefix: document.getElementById('auth-prefix').value`（不加 `||`）
- `hook_server.js` `POST /api/config`：`Object.prototype.hasOwnProperty.call(body, 'authPrefix') ? body.authPrefix : 'Bearer '`
- `hook_server.js` `buildApplyExpr`：`config.authPrefix !== undefined ? config.authPrefix : 'Bearer '`

**custom Provider 缺失**

Web 面板提交 `provider: 'custom'` 但 `ai_hook.js` 的 `PROVIDERS` 对象只有 `gemini` 和 `gemini_flash`。`switchProvider('custom')` 失败后 Hook 使用默认 Provider，配置不生效。修复：在 `PROVIDERS` 中添加 `custom` 项，所有字段为空字符串，由 `hook_server.js` 注入后通过 `setApiUrl`/`setApiKey`/`setModel`/`setAuthHeader`/`setAuthPrefix` 逐项设置。

**uninstall() 可逆 Hook**

初期重注入只清除 `window.__aiHookInstalled = false` 标志，不恢复原始 `JSON.stringify` and `window.fetch`。多次注入会产生包装链（wrapper chain）：当前 Hook 保存的 `origFetch` 实际是上一层 Hook 的包装函数，`uninstall()` 只退回一层。修复：

- `ai_hook.js` 新增 `uninstall()` 方法，恢复 `JSON.stringify = origStringify; window.fetch = origFetch`，再清除标志和 `window.__aiHook` 对象
- `hook_server.js` 的 `injectHook` 在注入前调用 `window.__aiHook.uninstall()`
- 所有旧注入脚本（`clear_hook.js`、`inject_hook_auto.js`、`hook_monitor.js` 等）已删除，收敛为 `hook_server.js` 唯一注入路径

> **历史包装链清理**：若曾用旧脚本注入过 Hook，`uninstall()` 只能退回一层。彻底清理需要关闭影刀 AI 对话页面再重新打开，`hook_server.js` 检测到 page ID 变化后全新注入。

**前端 apply 失败静默**

服务端 `POST /api/config` 在 CDP 下发失败时返回 `{ success: false, error: '...' }`，但 HTTP 状态码仍为 200。前端 `apiCall` 只检查 `res.ok`，不检查 `result.success`，用户看到"设置已成功应用"但实际 Hook 仍用旧配置。修复：前端 apply handler 赋值 `const result = await apiCall(...)`，检查 `result.success === false` 时 `throw new Error(result.error)`，进入 catch 块显示错误 toast。

### 14.3 健壮性改进（P2）

**页面选择**

初期 `pages.find(p => p.type === 'page')` 取第一个页面，可能与非影刀的 CefSharp 页面冲突。修复为 `findShadowBotPage`：优先匹配 `url` 包含 `shadowbot` 的页面，回退到首个 `type === 'page'`。

**Node.js 版本要求**

README 早期标注 Node.js v18+，但 `globalThis.WebSocket` 是 Node.js v22.4+ 才有的原生实现。已更新为 v22.4+。

### 14.4 已知架构限制

**lastMessages 全局单槽**

`ai_hook.js` 通过全局 `JSON.stringify` Hook 捕获加密前的明文 messages，存入模块级变量 `lastMessages`。角色过滤（`role ∈ {user, system, assistant}`）和即时清理（捕获后立即置 `null`）降低了冲突概率，但本质上不是并发安全的：在 JSON.stringify 捕获与 fetch 拦截之间，如果另一段代码也序列化了 role-array，`lastMessages` 会被覆盖。

彻底修复需要在加密前的具体调用点关联消息与请求，而非 Hook 全局 `JSON.stringify`。这需要深入混淆的 `index.js` 找到精确的加密函数调用点，属于后续架构改进。

### 14.5 维护检查清单

后续修改项目代码后，建议按以下步骤验证：

1. **进程检查**：`netstat -ano | findstr :3000` 确认只有 `127.0.0.1:3000` 一个 LISTENING，无 `0.0.0.0` 或 `[::]` 绑定
2. **密钥检查**：`grep -r "AQ\." *.js *.ps1 *.bat *.html` 确认密钥不出现在代码文件中，仅存在于 `hook_config.json`
3. **CORS 检查**：`curl -s -I http://127.0.0.1:3000/api/config` 确认响应头无 `Access-Control-Allow-Origin`
4. **掩码验证**：`curl -s http://127.0.0.1:3000/api/config` 确认 `apiKey` 为 `****XXXX` 格式
5. **authPrefix 验证**：同上确认 `authPrefix` 为 `"Bearer "`（含尾空格）
6. **前端逻辑**：浏览器打开 `http://localhost:3000`，清空"前缀"字段后点"应用设置"，确认提交值为空字符串而非 `Bearer `
7. **apply 失败**：停止影刀后在 Web 面板修改配置点"应用设置"，确认显示失败提示而非成功
8. **旧脚本清理**：确认 `C:\Users\26503\Desktop\rpajs\` 目录无 `clear_hook.js`、`hook_monitor.js`、`inject_hook_auto.js` 等已合并删除的脚本
9. **文档一致性**：`grep -r "node hook_monitor\|node clear_hook\|node inject_hook" *.md` 确认文档不指导运行已删除的脚本
10. **数据流完整性**：在影刀中新建流程并发送 "生成一个简单的Excel读取流程" 指令，查看工具调用流程是否顺畅，并确认无 `reasoning_trace` 缺失警告

---

## 附录：影刀 AI 工具参数速查

影刀后端期望的工具参数格式（snake_case + reasoning_trace）：

| 工具 | 必填参数 | 可选参数 | reasoning_trace |
|------|----------|----------|-----------------|
| `load_skill` | `skill_name` | — | ✅ 必填 |
| `execute_skill_tool` | `skill_name`, `method` | `explanation`, `params` | ✅ 必填 |
| `commit_code_patch` | `patch` | — | ✅ 必填 |
| `enter_mode` | `mode` | `explanation` | ✅ 必填 |
| `task_done` | — | `summary` | ✅ 必填 |
| `read_file_data` | `file_path` | — | ✅ 必填 |
| `ask_user_question` | `question` | — | ✅ 必填 |

> `reasoning_trace` 为中文推理过程，描述从上一步到决定调用此工具的完整思考链。虽然 schema 的 `required` 数组中不包含它，但描述标注为 `中文必填`，实际运行时必须填写。

---

*项目完成日期：2026-07-14*
*逆向工具：dnSpy.Console.exe, Chrome DevTools Protocol*
*运行环境：Windows 10, Node.js v26+, 影刀 RPA v6.2.21*
