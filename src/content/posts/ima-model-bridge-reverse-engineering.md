---
author: tom613951
pubDatetime: 2026-09-28T00:00:00Z
title: ima Model Bridge: 腾讯 ima「问问ima」AI 请求链逆向与模型接入
postSlug: ima-model-bridge-reverse-engineering
featured: true
draft: false
tags:
  - 逆向工程
  - ima
  - 协议分析
  - SSE
  - DeepSeek Harness
description: 本文记录了在不依赖 ima 桌面客户端常驻的前提下，通过 CDP 抓包与 JS 逆向还原「问问ima」模块的问答协议，包括 DJB2 签名算法还原、SSE 流式事件解析、模型编号体系与 token 自动续期机制，并实现为 DeepSeek Harness 的模型提供方插件。
---

# ima Model Bridge: 腾讯 ima「问问ima」AI 请求链逆向与模型接入

> **项目类型**：Web 应用逆向工程、协议分析、流式协议兼容与插件工程化  
> **目标站点**：腾讯 ima（ima.qq.com）「问问ima」模块  
> **当前版本日期**：2026-09-28  
> **最终成果**：不依赖 ima 桌面客户端常驻，通过读取一次浏览器登录态凭据，还原并实现了完整的问答协议调用链；支持 8 个模型的流式对话（含思维链），并实现了基于 refreshToken 的 30 天滚动自动续期  
> **技术栈**：Chrome DevTools Protocol、JavaScript/Node.js、ES Module 静态分析、DJB2 哈希还原、protobuf 手工解码、SSE 流式解析

---

本文记录我独立完成腾讯 ima「问问ima」模块协议逆向，并实现为 DeepSeek Harness 模型提供方插件的全过程。
我从 CDP 网络抓包出发，逐层还原了会话建档、流式问答、token 续期三条调用链，定位并验证了 `x-ima-bkn` 的签名算法，
并对一个未能闭环的接口准入问题做了系统性排除。

这不是一篇只给出最终代码的使用说明。我会明确区分三类结论：抓包与运行结果中可直接观察到的事实、
由多项实验证据支持的工程推断，以及当前版本仍然存在的问题。

## 摘要

DeepSeek Harness（下称 DSH）通过 LLM seam 支持接入第三方模型提供方。已有的
`dsh-provider-qoder`、`dsh-workbuddy-connect` 两个插件，分别读取 Qoder 与 CodeBuddy 桌面端
落盘凭据，实现了「一次配置、长期可用」的模型桥接。

本文记录我为腾讯 **ima**（https://ima.qq.com/）的「问问ima」模块实现同类接入的完整过程。
工作分为四部分：**协议逆向**、**算法还原**、**插件实现**、**准入排查**。

主要产出：

- 还原了 ima Web 端问答接口的完整调用链，包括 `init_session` 建档、`qa` 流式问答、
  `auth_login/refresh` 续期三个端点；
- 从混淆产物中定位并验证了 `x-ima-bkn` 的生成算法（DJB2 变体），实测与抓包逐位一致；
- 解析了 SSE 事件协议，明确了正文与思维链两类内容块的字段映射；
- 实现了基于 `refreshToken` 的自动续期（30 天滚动），解决了 IMA-TOKEN 仅 2 小时有效的固有问题；
- 插件代码完成并与 DSH 集成，8 个模型的 `model_type` 编号经实测确认；
- **一个未能闭环的问题**：`assistant/qa` 接口在排查后期恒定返回业务码 `Code=3`，
  经系统性排除后判定为账号级准入限制，非实现缺陷。

---

## 一、背景与目标

### 1.1 已有实现的架构范式

参考 `dsh-workbuddy-connect` 的实现，可以归纳出这类桥接插件的通用范式：

```
┌─────────────┐     OpenAI 格式      ┌──────────────┐     私有协议     ┌──────────┐
│  DSH / pi-ai │ ──────────────────▶ │ loopback shim │ ─────────────▶ │  上游服务 │
│              │ ◀────────────────── │  (127.0.0.1)  │ ◀───────────── │          │
└─────────────┘  chat.completion.    └──────────────┘     SSE / HTTP    └──────────┘
                       chunk
```

核心设计是：**插件在本地回环地址上起一个 HTTP 服务，对外暴露 OpenAI Chat Completions
兼容接口，对内负责与真实上游的协议转换**。这样 pi-ai 无需感知上游差异，
上游替换对 DSH 完全透明。

凭据获取方式上，两者都采用「读取桌面端落盘的凭据文件」：

| 插件 | 凭据来源 |
|---|---|
| `dsh-workbuddy-connect` | `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |
| `dsh-provider-qoder` | `%APPDATA%/com.qoder.app.stable/auth.v1.dat` |

### 1.2 ima 的目标与约束

目标是将 ima「问问ima」模块中的免费模型接入 DSH。该模块提供以下模型：

| 显示名称 | 快速 | 深度 |
|---|---|---|
| DeepSeek-V4-Flash | ✓（默认） | ✓ |
| Hy3 | ✓ | ✓ |
| Hy4 preview | ✓ | ✓ |
| GLM-5.3-Flash | ✓ | ✓ |

约束条件是**凭据一次性配置、长期可用，且不要求 ima 桌面端常驻**。

---

## 二、协议逆向

### 2.1 环境与方法

ima Web 端是标准 Chromium 应用的 Web 部分，前端由 Vite 构建，产物为 ES Module。
逆向采用以下手段：

1. **CDP 网络域抓包** —— 通过 Chrome DevTools Protocol 的 `Network` domain 获取完整请求/响应，
   包括请求体与响应体原文。这是本次工作的主要信息来源。
2. **静态分析** —— 下载并分析主 bundle（约 4 MB）与各 chunk，定位接口调用与算法实现。
3. **在线验证** —— 用 Node.js `fetch` 复现请求，与抓包结果比对。

> **踩坑记录**：最初尝试 hook `window.fetch` 与 `XMLHttpRequest.prototype`，均未命中。
> 原因是应用在初始化阶段缓存了原生引用，此后所有调用都绕过 hook。
> 结论：**对这类经过构建工具处理的应用，CDP 网络域比运行时 hook 更可靠**。

### 2.2 端点清单

网络抓包识别出四个关键端点，均位于 `https://ima.qq.com/cgi-bin/` 之下：

```http
POST /cgi-bin/session_logic/init_session
     会话建档。请求体仅含环境信息，响应返回服务端生成的 session_id。

POST /cgi-bin/assistant/qa
     流式问答。Content-Type 为 text/plain，响应为 text/event-stream。

POST /cgi-bin/auth_login/refresh
     token 续期。用 refreshToken 换取新的 access token。

POST /cgi-bin/model_manage/get_models
     模型目录。免登录接口，返回当前账号可用的模型列表。
```

### 2.3 鉴权头构造

请求头由浏览器端的 `HeaderService`（类 `al`）统一生成。其核心实现如下：

```js
let al = class {
  constructor(cookieService, jsVersion) {
    this.cookieService = cookieService;
    this.jsVersion = jsVersion;
    this.getHeader = async () => {
      const n = await this.cookieService.getCookie();
      const r = this.cookieService.encodeCookie(n);
      const i = n["IMA-TOKEN"];
      return {
        "x-ima-cookie": r,
        from_browser_ima: "1",
        extension_version: this.jsVersion,
        ...(i ? { "x-ima-bkn": String(Pg(i)) } : {})
      };
    };
  }
};
```

`x-ima-cookie` 的结构（实测抓包原文，已脱敏）：

```
PLATFORM=H5; CLIENT-TYPE=256053; WEB-VERSION=999.999.999;
IMA-GUID=guid-<uuid42>; IMA-Q36=<uuid42>;
IMA-IUA=<User-Agent>; IMA-UID=<uid>;
IMA-TOKEN=<token>; IMA-REFRESH-TOKEN=<refresh_token>;
UID-TYPE=2; TOKEN-TYPE=14
```

其中 `uid` 与 `guid` 来自登录态，`idType` / `tokenType` 来自账号信息对象。

### 2.4 bkn 算法还原

`x-ima-bkn` 是唯一的非平凡派生字段。通过调用链溯源定位到其实现：

主 bundle 的导出标识符 `EE`，回溯至 `awesome-BVSLqIPa.js` 导出的 `g`，
其本地标识符为 **`Pg`**，定义如下：

```js
Pg = t => {
  try {
    let e = 5381;
    for (let n = 0, r = t.length; n < r; ++n)
      e += (e << 5) + t.charAt(n).charCodeAt(0);
    return e & 2147483647;
  } catch (e) { return 0 }
},
```

这是经典的 **DJB2** 哈希：`(e << 5) + e` 等价于 `e * 33`，末尾 `& 0x7FFFFFFF` 保证结果非负。

**验证**：对实测 token 计算得到 `2068844366`，与抓包中的 `x-ima-bkn` 头逐位一致。
该算法**完全本地可算**，不涉及网络请求、时间戳或服务端 nonce。

```js
function imaBkn(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i += 1) {
    h += (h << 5) + token.charCodeAt(i);
  }
  return h & 0x7fffffff;
}
```

### 2.5 SSE 事件协议

`assistant/qa` 的响应是标准 SSE。实测一次完整问答共产生约 17 个 `STRUCTURED_BLOCK` 事件，
事件类型分布如下：

| event | 次数 | 说明 |
|---|---|---|
| `QA_START` | 1 | 会话开始，回显 `model_type` / `trace_id` / `model_info` |
| `SESSION_START` | 1 | 携带 `MsgSeqID` |
| `STRUCTURED_BLOCK` | 17 | 内容载体，见下 |
| `HEARTBEAT` | 1 | 心跳 |
| `SUGGEST_QUESTION` | 1 | 推荐追问 |
| `ATTACHED_BLOCK` | 1 | 附件块 |
| `COMPLETED` / `CLOSE` | 各 1 | 结束 |

`STRUCTURED_BLOCK` 通过 `Type` 字段区分载荷类型，字段名映射关系如下：

| `Type` | 数据路径 | 语义 |
|---|---|---|
| `blockMessage` | `Data.text_message.Text` | 正文 |
| `blockThinking` | `Data.thinking_message.Message` | 思维链 |
| `loading` | — | 加载占位（含 `UpdateType: create/delete`） |
| `qaDownloadGuide` | `Data.download_channel` | 下载引导 |

正文块样本：

```json
{"Type":"blockMessage","Data":{"text_message":{"Text":"12"}},"Id":"87c8b57b20cd4bec87e57edc3a946cd4"}
```

**关键观察**：深度模式下会先产生大量 `blockThinking` 块（实测 13~26 个），
`blockMessage` 仅 1 个且内容极短。翻译层若只处理 `blockMessage` 而忽略 `blockThinking`，
会在深度模式下丢失全部推理过程。

### 2.6 请求体与三个实现陷阱

从 CDP 抓取的首条消息请求体（1069 字节，已脱敏）：

```json
{
  "session_id": "6aba5113ef69ba575f770637cfebd3517d2a",
  "robot_type": 10000,
  "question": "8乘8等于几？只回答数字",
  "question_type": 3,
  "client_id": "dda18350-bb30-11f1-8c86-f1c3fb30b88d",
  "model_info": { "model_id": "official_3", "model_type": 3, "enable_enhancement": true },
  "history_info": { "type": 0 },
  "device_info": {
    "uskey": "<约 500 字符 base64>",
    "uskey_bus_infos_input": "<guid>_<timestamp>"
  },
  "client_tools": []
}
```

实现过程中踩到三个陷阱，每个都导致 HTTP 200 但内容为空流（仅含 `COMPLETED`/`CLOSE`）：

**陷阱一：`robot_type` 必须为 `10000`**

传 `0` 会被服务端判定为机器人通道并直接拒绝生成，返回恒定长度的空响应。
`10000` 才是「问问ima」的普通用户通道标识。

**陷阱二：`question` 必须是裸字符串**

前端源码中大量出现 `question.content` 的读取，容易误导为应传对象 `{content: "..."}`。
但那是渲染层从实体对象取值，**实际发送时是字符串**。传对象会导致空流。

**陷阱三：`session_id` 必须来自 `init_session`**

服务端**不接受客户端自造的 `session_id`**，且不会报错 —— 对未知 id 直接返回空流。
正确的顺序是先 `init_session` 建档，用响应中返回的 id 再发 `qa`。

值得特别注意的是 `session_logic/get_session` 这个端点的命名具有误导性：
它的语义是「读取已存在会话」而非「创建会话」。对不存在的 id 调用它会返回
业务码 `200201`（`很抱歉，ima遇到了点小问题`），这一度让我误判了建档位置。

**最小可用字段集**：经逐字段二分验证，`{ session_id, robot_type, question, model_type }`
四个字段即可完成一次正常问答；`model_info` / `question_type` / `client_id` /
`history_info` / `device_info` / `client_tools` 均非必需（在准入正常的前提下）。

---


## 三、模型编号与设备指纹

### 3.1 模型目录接口

`POST /cgi-bin/model_manage/get_models` 返回当前账号的完整模型目录。
响应结构为模型「组」的数组，每个组内含快速/深度两套编号：

```json
{
  "code": 0,
  "models": [{
    "model_id": "official_3",
    "model_name": "DeepSeek-V4-Flash",
    "model_type": 3,
    "short_model_name": "DS",
    "is_default": true,
    "is_new": false,
    "sub_model_infos": {
      "0": { "model_id": "official_3", "model_type": 3 },
      "1": { "model_id": "official_1", "model_type": 1 }
    },
    "sub_model_types": { "0": 3, "1": 1 }
  }]
}
```

`sub_model_infos["0"]` 对应「快速」模式，`["1"]` 对应「深度」模式。
完整的编号表：

| 模型 | 快速 `model_type` | 深度 `model_type` |
|---|---|---|
| DeepSeek-V4-Flash | 3 | 1 |
| Hy3 | 0 | 2 |
| Hy4 preview | 1001 | 1002 |
| GLM-5.3-Flash | 3000 | 3001 |

**验证方法**：对每个编号单独发起询问「你是哪个模型」，观察自述与响应特征。
结果 8/8 全部返回正文，且深度系列的思维链长度为 243~1934 字符、快速系列接近于 0，
`model_type: 3000` 自述「运行在智谱 GLM 大模型上」，说明各编号确实路由到不同的真实上游，
而非落到默认模型的兜底响应。

> **旁证**：对未注册的编号（如 `official_4`~`official_9`）服务端返回**长度几乎相同**的兜底响应
> （1863~1865 字节），与上述 8 个编号响应长度各异形成鲜明对比。这为「编号真实有效」提供了
> 反向证据。

### 3.2 uskey 的本地生成

`device_info.uskey` 由腾讯 QIMEI SDK 生成。该 SDK 是纯前端实现，可脱离浏览器环境调用：

```js
const mod = await import("https://fe-static.ima.myqcloud.com/ima/assets/chat/assets/qimeisdk-*.js");
const QimeiWeb = mod.default;
const inst = new QimeiWeb({ appkey: "0WEB0698R9XOG65A" });

inst.getUSKeySync();   // 同步返回，纯本地计算
// → "DCAxFeb05pDmvvCtOP3B8IOqDrUH5/8iaa2rOAqTUdR9LCT4ldBle1o85xW7s02md..."
```

实例还暴露 `getUuid` / `getQimei36` / `getSign` / `getUSKey`（异步）等方法。

> **注意**：`getUSKeySync()` 是**纯本地计算**，不产生网络请求。
> 异步版本 `getUSKey()` 会向腾讯服务器请求，在某些环境下会长时间阻塞，
> 调试时容易误判为「需要联网」。

---

## 四、Token 续期机制

### 4.1 问题的由来

`IMA-TOKEN` 的有效期仅 **2 小时**（`tokenValidTime: 7200`）。
若直接使用，插件会在两小时后失效，不满足长期可用的要求。

### 4.2 账号信息中的时间字段

登录态对象 `ima-universal-local-storage-accountInfo` 中包含完整的时间信息：

```json
{
  "token": "...",
  "refreshToken": "...",
  "uid": "001a8d9235803999",
  "guid": "guid-1a91c123418100519a9bf8d7e76037a5eb4c3ef1fe",
  "idType": "2",
  "tokenType": 14,
  "tokenValidTime": 7200,
  "refreshTokenValidTime": 2592000,
  "tokenExpiredTime": 1790607770433,
  "refreshTokenExpiredTime": 1793186147749
}
```

换算后：**token 有效期 2 小时，refreshToken 有效期 30 天**。
这正是长期可用的基础 —— 与 workbuddy / qoder 的「读一次配置长期使用」在效果上等价。

### 4.3 续期接口

```http
POST /cgi-bin/auth_login/refresh
Content-Type: application/json

{ "userId": "<uid>", "refreshToken": "<refresh_token>" }
```

响应：

```json
{ "code": 0, "msg": "ok", "token": "<新 token>", "token_valid_time": "7200", "user_id": "..." }
```

> **一个值得记录的细节**：服务端在参数错误时返回的提示是
> `invalid RefreshReq.UserId: value length must be at least 1 runes`。
> 这是 Go 的 protobuf 校验器输出，`UserId` 是**消息类型字段名**（PascalCase）。
> 但 JSON 序列化遵循小驼峰约定 —— **实际必须传 `userId`**，
> 传 PascalCase 的 `UserId` 依然会报同样的错。
> 换言之，这条错误信息里的字段名**不是可以直接照抄的 JSON 键名**，这是一个容易踩的坑。

### 4.4 工程实现

在插件中实现了带缓存的自动续期：

```js
let cachedToken = null;   // { token, expiresAt }

async function ensureFreshToken(credential, log) {
  const now = Date.now();

  // 1. 内存缓存命中（保留 5 分钟余量）
  if (cachedToken && cachedToken.expiresAt - now > 5 * 60 * 1000) {
    return { ...credential, token: cachedToken.token };
  }

  // 2. 落盘凭据自带过期时间，可直接判断，省一次网络往返
  const exp = Number(credential.tokenExpiredTime);
  if (exp > 0 && exp - now > 5 * 60 * 1000) {
    cachedToken = { token: credential.token, expiresAt: exp };
    return credential;
  }

  // 3. 调用续期接口
  const fresh = await refreshImaToken(credential, log);
  if (!fresh) return credential;   // 失败时退回原 token，让上游如实报错
  cachedToken = { token: fresh.token, expiresAt: now + fresh.tokenValidTime * 1000 };
  return { ...credential, token: fresh.token };
}
```

三级判断的意义：**绝大多数请求走第 1 或第 2 级，完全不产生额外网络开销**；
只有临近过期时才触发第 3 级。
由于 refreshToken 每次刷新都会滚动续期（30 天），该机制理论上可持续无限期运行。

---

## 五、插件架构

### 5.1 整体结构

```
dsh-provider-ima/
├── package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # insert: llm-ima → dsh-provider-ima
└── lib/
    ├── index.js          # 插件入口：apply / inject / Config + PiAiAdapter
    └── ima-core.js       # 协议实现：bkn / 凭据 / 建档 / 续期 / SSE 翻译 / shim
```

`ima-core.js` 保持**零外部依赖**：DSH 家目录解析通过 `setDshHomeResolver()` 依赖注入，
使该模块可以脱离 DSH 环境独立进行单元测试。

### 5.2 协议转换链路

```
pi-ai 发出的 OpenAI 请求
   │
   ▼  lastUserText()        提取最后一条 user 文本
   ▼  ensureFreshToken()    token 有效性检查 / 自动续期
   ▼  initImaSession()      会话建档（首次）
   ▼  buildImaCookie() + imaBkn()   组装鉴权头
   │
   ▼  POST /cgi-bin/assistant/qa
   │
   ▼  createImaTranslator()
        ├─ blockMessage  → delta.content
        ├─ blockThinking → delta.reasoning_content
        └─ 其余          → 忽略
   │
   ▼  OpenAI chat.completion.chunk 流
```

### 5.3 并发处理

DSH 会在同一毫秒内并发发起多条请求（例如正常对话与自动生成会话标题）。
若 `init_session` 的调用未做去重，两个并发请求会各自建一个会话并互相覆盖，
日志中可见「25 毫秒内两次 `session created`」的现象。

解决方案是用 in-flight Promise 复用：

```js
let initPromise = null;

function acquireSession(credential) {
  if (initPromise === null) {
    initPromise = initImaSession(credential, logger).then(sid => {
      if (!sid) initPromise = null;   // 失败允许重试
      return sid;
    }, e => { initPromise = null; throw e; });
  }
  return initPromise;
}
```

> **一次错误尝试的教训**：我曾在返回时给 `session_id` 拼接序号后缀
> （`sid + "-" + seq`）以图「每请求独立会话」。但 `session_id` 是**服务端生成的受控格式**，
> 任何改写都会导致服务端不识别并返回空流 —— 这把原本偶发的竞态问题
> 升级成了必然失败。修复后恢复。**结论：服务端下发的标识符不应做任何加工。**

### 5.4 集成到 DSH

插件需要通过 profile 的**显式清单**注册，仅放入 `node_modules` 不会生效：

```json
{
  "dependencies": { "dsh-provider-ima": "0.1.0" },
  "dsh": {
    "profile": {
      "bundles": [ "...", "dsh-provider-ima" ],
      "patchReload": "live"
    }
  }
}
```

> `patchReload: "live"` 仅对 `cordis.patch.yml` 的热重载生效；
> **插件 JS 代码的变更需要重启 DSH 进程**才会加载。这一点在调试时容易混淆 ——
> 文件已更新但进程仍在运行旧模块，会造成「修改无效」的假象。

---


## 六、未能闭环的问题

### 6.1 现象

在实现过程中，`assistant/qa` 接口开始恒定返回如下响应（**恒为 249 字节**）：

```
event: COMPLETED
data: {"Code":3,"Msg":"","MsgSeqID":"",
       "IntentReportID":{"FirstID":0,"SecondID":0,"ThirdID":0},
       "DebugProfile":{"TraceID":"","会话ID":"","RobotType":0,"关键步骤列表":null}}

event: CLOSE
data: [DONE]
```

关键特征是 **`DebugProfile` 全为空值**：`TraceID`、`会话ID` 为空字符串，`RobotType` 为 0
（而请求中明确传入了 `robot_type: 10000`）。同时，响应中**从不出现 `QA_START`** ——
而正常响应的第一个事件必然是它。

这些特征共同表明：**请求在路由到 QA 服务之前就被终止了，请求体根本未被解析**。

### 6.2 系统性排除

为定位原因，逐项做了对照实验，可将下列因素全部排除：

| 假设 | 验证方法 | 结论 |
|---|---|---|
| token 过期 | 用 `auth_login/refresh` 换出全新 token 后立即请求 | 已排除 |
| 会话未建档 | `init_session` 返回 `code:0` 及合法 `session_id` | 已排除 |
| 请求体字段缺失 | 逐字段二分测试；补回 `model_info`/`history_info`/`client_tools` | 已排除 |
| `client_id` 格式 | 分别尝试 UUID、抓包原值、`sid + 后缀` 三种形态 | 已排除 |
| 缺少设备指纹 | 用 QimeiWeb 生成真实 `uskey` 并完整传入 `device_info` | 已排除 |
| 网络指纹 / WAF | 在浏览器页面内用 `fetch` 直发（真 TLS 指纹、真同源） | 已排除 |
| 鉴权头不完整 | 补齐 `User-Agent`、`sec-ch-ua` 系列、`traceparent` 等 | 已排除 |
| 接口下线 | 同一 token 调用 `init_session` 正常返回 | 已排除 |

值得注意的是**第二个实验**：`init_session` 与 `assistant/qa` 使用**完全相同的鉴权头**，
前者能正常通过而后者被拒。这直接证明了**问题不在鉴权层**。

### 6.3 与客户端行为的对比

同一账号在 ima 桌面客户端中工作正常。对比两者使用的协议后发现它们**完全不同**：

| | Web API（本次使用的） | 桌面客户端 |
|---|---|---|
| 协议 | HTTPS `POST /cgi-bin/assistant/qa` | MSF 二进制私有协议 |
| 连接 | 短连接 | 443 端口长连接 |
| 认证 | `x-ima-cookie` + `x-ima-bkn` | SSO 握手令牌（内存态） |

从客户端进程的实际连接可以看出 MSF 服务器地址：

```
60.29.242.141:443
60.29.232.22:443
116.130.223.156:443
```

这些地址与客户端连接配置文件 `imsdk_config` 中记录的 SSO 地址池
（`60.29.232.85` / `60.29.232.121` / `220.194.118.231` …）属于同一网段。

### 6.4 客户端凭据不可提取

为判断是否可复用客户端凭据，对其数据目录做了完整检查。
客户端的 IM SDK 数据位于 `imsdk/` 下，内容为：

```
im.db        SQLite —— userinfo / userconfig / session / idcache 等表
msg_0.db     SQLite —— message 表
imsdk_config 连接配置 —— 服务器 IP 池、设备 ID、账号，但无凭据
```

其中 `userconfig` 表内有一个看似可疑的字段 `synchronize_c2c_cookie`（28 字节）。
解码后确认其为 protobuf 编码的**同步游标**（记录消息同步进度的时间戳与序号），
而非认证令牌：

```
hex: 08ac8ae9d506 10a2d7e9d506 28cbb1d6a801 38e6a6f5c8aaecefea18
     └ field1       └ field2      └ field5      └ field7
     (时间戳)        (时间戳)       (序号)         (时间戳)
```

**结论：客户端的认证凭据不落盘**，仅存在于长连接的会话状态中。
因此无法采用与 `dsh-provider-qoder`（读取 `auth.v1.dat`）、
`dsh-workbuddy-connect`（读取 `workbuddy-desktop.info`）相同的方式。

### 6.5 曾评估过的另一条路径

ima 为其扩展提供了自定义权限 `imaFrame`，扩展可调用
`chrome.imaFrame.invoke({action, params})`。我完整枚举了该接口的能力面：

```
方法：  invoke / invokeWithCallback / callbackFromNative
事件：  onAIMessage / onAttachmentProgress / onAudioPlayStatusChange / ...
动作：  closeUrlSidePanel / openSidePanelWithUrl / log / checkWasmValid
        getSystemState / setTranslateIconState / qa_tts / screenShot
        runAction / getMeta / mindmap_viewer_edit_action
```

**全部为 UI 控制类接口，不存在任何「提交问题给模型」的能力。**
与其最接近的 `qa_tts` 仅用于对已有回答进行语音合成。
这从架构上印证了前面的判断：扩展层只能触及宿主 UI，
真正的问答逻辑位于主程序内部并通过 MSF 长连接与服务端交互。

### 6.6 判断

排除上述所有因素后，最可能的解释是**账号级的调用频次风控**。
时间线支持这一判断：

| 时间 | 事件 |
|---|---|
| 排查前期 | 8 个模型逐个实测，**全部返回正常正文** |
| 之后约 20 分钟 | 调试过程中密集发起 60+ 次请求 |
| 此后 | 同一构造、同一 token 的请求**恒定返回 `Code=3`** |

同一份代码从可用变为不可用，期间唯一的变量是请求频次。
若属实，该限制应随时间推移自动解除。

---

## 七、结论

### 7.1 已完成

| 项目 | 状态 |
|---|---|
| 端点与调用链识别 | 完成 |
| `x-ima-bkn` 算法还原与验证 | 完成（逐位一致） |
| SSE 协议解析（含思维链） | 完成 |
| 模型编号表（8 个 `model_type`） | 完成（实测确认） |
| `uskey` 本地生成方案 | 完成 |
| token 自动续期（30 天滚动） | 完成并验证 |
| 插件实现与 DSH 集成 | 完成 |
| 并发竞态处理 | 完成 |
| **`qa` 接口实际调用** | **受阻（服务端 `Code=3`）** |

### 7.2 架构层面的结论

**就「一次配置、长期可用、客户端不常驻」这一目标而言，实现路径已经打通。**
token 续期机制使得凭据可以无限期自动维护，这一点与 workbuddy / qoder 的效果等价。

但在**凭据提取方式**上，ima 与两者存在本质差异：

| | workbuddy | qoder | ima |
|---|---|---|---|
| 凭据落盘 | 是（明文文件） | 是（数据文件） | **否**（仅内存态） |
| 提取方式 | 读文件 | 读文件 | 需从浏览器登录态导出 |

这一差异源于产品形态：**ima 是 IM 客户端**，其凭据服务于长连接握手，
按安全实践不落盘；而 workbuddy / qoder 是工具类应用，凭据需要跨进程复用。

### 7.3 后续

当前剩余工作仅为等待服务端准入恢复。届时应无需改动任何代码。

自检脚本：

```powershell
node check-ima-quota.mjs
```

---

## 附录 A：核心算法与常量

```js
// bkn —— DJB2 变体
function imaBkn(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i += 1) h += (h << 5) + token.charCodeAt(i);
  return h & 0x7fffffff;
}

// 常量
const IMA_ORIGIN       = "https://ima.qq.com";
const IMA_INIT_PATH    = "/cgi-bin/session_logic/init_session";
const IMA_QA_PATH      = "/cgi-bin/assistant/qa";
const IMA_REFRESH_PATH = "/cgi-bin/auth_login/refresh";
const IMA_MODELS_PATH  = "/cgi-bin/model_manage/get_models";
const IMA_ROBOT_TYPE   = 10000;   // 0 会被判为机器人通道
```

## 附录 B：错误码

| 错误码 | 出现位置 | 含义 |
|---|---|---|
| `code: 0` | `init_session` / `refresh` | 成功 |
| `code: 51` | `auth_login/refresh` | 参数校验失败（如缺 `userId`） |
| `code: 200201` | `session_logic/get_session` | 会话不存在 |
| `Code: 3` | `assistant/qa` | 业务拒绝（准入层，未进入 QA 服务） |

## 附录 C：参考资料

- 目标站点：https://ima.qq.com/chat
- 抓包工具：Chrome DevTools Protocol（`Network` domain）
- 参考实现：`dsh-workbuddy-connect`、`dsh-provider-qoder`
