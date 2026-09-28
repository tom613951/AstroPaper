---
author: tom613951
pubDatetime: 2026-09-28T00:00:00Z
title: ima Model Bridge：腾讯 ima「问问ima」AI 请求链逆向与模型接入
postSlug: ima-model-bridge-reverse-engineering
featured: true
draft: false
tags:
  - 逆向工程
  - ima
  - 协议分析
  - SSE
  - DeepSeek Harness
description: 通过 CDP 抓包与 ES Module 静态分析还原腾讯 ima「问问ima」模块的问答协议，涵盖 DJB2 签名算法还原、SSE 流式事件解析、模型编号体系与 refreshToken 滚动续期，并落地为 DeepSeek Harness 的模型提供方插件。
---

# ima Model Bridge：腾讯 ima「问问ima」AI 请求链逆向与模型接入

> **项目类型**：Web 协议逆向、流式接口兼容、插件工程化  
> **目标站点**：ima.qq.com「问问ima」模块  
> **版本日期**：2026-09-28  
> **成果**：不依赖桌面客户端常驻，单次凭据配置后由 refreshToken 自动滚动续期；支持 8 个模型的流式对话与思维链输出  
> **技术栈**：Chrome DevTools Protocol、ES Module 静态分析、DJB2 哈希还原、protobuf 手工解码、SSE 流式解析、Node.js

---

ima 官方只提供桌面客户端与 Web 界面，未开放 API。本文记录从 Web 端还原其问答协议并封装为 DeepSeek Harness 模型提供方的过程。

涉及三类结论需要区分：抓包与运行输出中可直接观察到的事实、由对照实验支持的工程推断、当前版本仍未解决的问题。

## 一、参考实现的架构范式

`dsh-workbuddy-connect` 与 `dsh-provider-qoder` 采用同一套结构：

```
┌──────────────┐   OpenAI 格式    ┌───────────────┐    私有协议    ┌──────────┐
│  DSH / pi-ai │ ───────────────▶ │ loopback shim │ ────────────▶ │ 上游服务 │
│              │ ◀─────────────── │  127.0.0.1    │ ◀──────────── │          │
└──────────────┘  completion.chunk└───────────────┘   SSE / HTTP   └──────────┘
```

**插件在回环地址起一个 HTTP 服务对外暴露 OpenAI 兼容接口，对内完成协议转换。** pi-ai 无需感知上游差异。

两者的凭据来源均为桌面端落盘文件：

| 插件 | 凭据路径 |
|---|---|
| `dsh-workbuddy-connect` | `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |
| `dsh-provider-qoder` | `%APPDATA%/com.qoder.app.stable/auth.v1.dat` |

ima 是否适用同一路径，取决于它是否同样落盘凭据 —— 这一点在后文有结论。

## 二、协议逆向

### 2.1 抓包方式的选择

最初尝试 hook `window.fetch` 与 `XMLHttpRequest.prototype`，均未捕获到问答请求。原因是被 hook 的原生引用在应用初始化阶段已被闭包捕获，后续调用绕过 hook。

改用 **CDP 的 `Network` domain** 后完整获取了请求头、请求体与响应体。对于经过构建工具处理的前端产物，运行时 hook 的可靠性低于协议层抓包。

静态分析侧下载了主 bundle（约 4 MB）与全部 chunk。bundle 中 `/cgi-bin` 路径字面量仅 4 个，接口路径由 DI 注入的 `urlPrefix` 变量拼接而成，无法静态提取 —— 这也是最终依赖抓包确定端点的原因。

### 2.2 端点

```http
POST /cgi-bin/session_logic/init_session      会话建档，返回服务端生成的 session_id
POST /cgi-bin/assistant/qa                    流式问答，响应为 text/event-stream
POST /cgi-bin/auth_login/refresh              token 续期
POST /cgi-bin/model_manage/get_models         模型目录（免登录）
```

`session_logic/get_session` 的命名具有误导性：其语义为**读取**已存在会话而非创建会话。对不存在的 id 调用返回业务码 `200201`，一度造成建档位置的误判。

### 2.3 鉴权头生成

请求头由前端 `HeaderService` 统一生成：

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

`x-ima-cookie` 的结构（实测抓包，已脱敏）：

```
PLATFORM=H5; CLIENT-TYPE=256053; WEB-VERSION=999.999.999;
IMA-GUID=guid-<uuid42>; IMA-Q36=<uuid42>;
IMA-IUA=<User-Agent>; IMA-UID=<uid>;
IMA-TOKEN=<token>; IMA-REFRESH-TOKEN=<refresh_token>;
UID-TYPE=2; TOKEN-TYPE=14
```

### 2.4 bkn 算法还原

`x-ima-bkn` 是唯一的非平凡派生字段。调用链溯源路径为：主 bundle 导出标识符 `EE` ← `awesome-BVSLqIPa.js` 导出的 `g` ← 本地标识符 **`Pg`**。

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

标准 **DJB2**：`(e << 5) + e` 等价于 `e * 33`，末尾 `& 0x7FFFFFFF` 保证非负。

对实测 token 计算得 `2068844366`，与抓包中的 `x-ima-bkn` 头逐位一致。该算法无网络请求、无时间戳、无服务端 nonce。

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

一次完整问答产生约 17 个 `STRUCTURED_BLOCK`：

| event | 次数 | 说明 |
|---|---|---|
| `QA_START` | 1 | 回显 `model_type` / `trace_id` / `model_info` |
| `SESSION_START` | 1 | 携带 `MsgSeqID` |
| `STRUCTURED_BLOCK` | 17 | 内容载体 |
| `HEARTBEAT` | 1 | 心跳 |
| `SUGGEST_QUESTION` | 1 | 推荐追问 |
| `ATTACHED_BLOCK` | 1 | 附件块 |
| `COMPLETED` / `CLOSE` | 各 1 | 结束 |

`STRUCTURED_BLOCK` 按 `Type` 区分载荷：

| `Type` | 数据路径 | 语义 |
|---|---|---|
| `blockMessage` | `Data.text_message.Text` | 正文 |
| `blockThinking` | `Data.thinking_message.Message` | 思维链 |
| `loading` | — | 占位（含 `UpdateType: create/delete`） |
| `qaDownloadGuide` | `Data.download_channel` | 下载引导 |

正文块结构：

```json
{"Type":"blockMessage","Data":{"text_message":{"Text":"12"}},"Id":"87c8b57b20cd4bec87e57edc3a946cd4"}
```

深度模式下 `blockThinking` 先于 `blockMessage` 到达，实测 13~26 个不等，而 `blockMessage` 仅 1 个且内容极短。翻译层若仅处理 `blockMessage`，深度模式下会丢失全部推理过程。

### 2.6 请求体与三个必踩的坑

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

以下三点任一错误都会导致 HTTP 200 但内容为空流（仅含 `COMPLETED`/`CLOSE`）：

**`robot_type` 必须为 `10000`。** 传 `0` 被判定为机器人通道并直接拒绝生成，返回恒定长度的空响应。

**`question` 必须是字符串。** 前端源码中大量出现 `question.content` 读取，易误导为应传对象 `{content: "..."}`；那是渲染层从实体对象取值，实际发送时为字符串。

**`session_id` 必须来自 `init_session`。** 服务端不接受客户端自造的 id，且不报错 —— 对未知 id 直接返回空流。

逐字段二分测试表明，`{ session_id, robot_type, question, model_type }` 四个字段即可完成正常问答；其余字段在准入正常时非必需。

## 三、模型编号与设备指纹

### 3.1 模型目录

`POST /cgi-bin/model_manage/get_models` 返回模型「组」数组，每组含快速/深度两套编号：

```json
{
  "code": 0,
  "models": [{
    "model_id": "official_3",
    "model_name": "DeepSeek-V4-Flash",
    "model_type": 3,
    "short_model_name": "DS",
    "is_default": true,
    "sub_model_infos": {
      "0": { "model_id": "official_3", "model_type": 3 },
      "1": { "model_id": "official_1", "model_type": 1 }
    },
    "sub_model_types": { "0": 3, "1": 1 }
  }]
}
```

`sub_model_infos["0"]` 对应快速模式，`["1"]` 对应深度模式。完整编号：

| 模型 | 快速 `model_type` | 深度 `model_type` |
|---|---|---|
| DeepSeek-V4-Flash | 3 | 1 |
| Hy3 | 0 | 2 |
| Hy4 preview | 1001 | 1002 |
| GLM-5.3-Flash | 3000 | 3001 |

验证方式为对每个编号单独询问「你是哪个模型」，观察自述内容与响应特征。8 个编号全部返回正文；深度系列思维链长度 243~1934 字符，快速系列接近于 0；`model_type: 3000` 自述「运行在智谱 GLM 大模型上」。

反向证据：对未注册编号（`official_4`~`official_9`）服务端返回长度几乎相同的兜底响应（1863~1865 字节），与上述 8 个编号的响应长度差异形成对比。

### 3.2 uskey 的本地生成

`device_info.uskey` 由 QIMEI SDK 生成，该 SDK 为纯前端实现，可脱离浏览器环境调用：

```js
const mod = await import("https://fe-static.ima.myqcloud.com/ima/assets/chat/assets/qimeisdk-*.js");
const inst = new mod.default({ appkey: "0WEB0698R9XOG65A" });

inst.getUSKeySync();
// → "DCAxFeb05pDmvvCtOP3B8IOqDrUH5/8iaa2rOAqTUdR9LCT4ldBle1o85xW7s02md..."
```

实例暴露 `getUuid` / `getQimei36` / `getSign` / `getUSKey`（异步）等方法。

`getUSKeySync()` 为纯本地计算，不产生网络请求；异步版本 `getUSKey()` 会向腾讯服务器发起请求，在部分环境下长时间阻塞。

## 四、Token 续期

### 4.1 有效期结构

`IMA-TOKEN` 有效期仅 2 小时，直接使用会导致插件在两小时后失效。登录态对象 `ima-universal-local-storage-accountInfo` 中的时间字段：

```json
{
  "tokenValidTime": 7200,
  "refreshTokenValidTime": 2592000,
  "tokenExpiredTime": 1790607770433,
  "refreshTokenExpiredTime": 1793186147749
}
```

即 **token 2 小时，refreshToken 30 天**。

### 4.2 续期接口

```http
POST /cgi-bin/auth_login/refresh
Content-Type: application/json

{ "userId": "<uid>", "refreshToken": "<refresh_token>" }
```

```json
{ "code": 0, "msg": "ok", "token": "<新 token>", "token_valid_time": "7200", "user_id": "..." }
```

参数错误时返回 `invalid RefreshReq.UserId: value length must be at least 1 runes`。这是 Go protobuf 校验器输出，`UserId` 为**消息类型字段名**（PascalCase）；但 JSON 序列化遵循小驼峰，**实际必须传 `userId`**，传 PascalCase 同样报错。错误信息中的字段名不可直接照抄为 JSON 键名。

### 4.3 三级缓存实现

```js
let cachedToken = null;   // { token, expiresAt }

async function ensureFreshToken(credential, log) {
  const now = Date.now();

  // 1. 内存缓存命中（保留 5 分钟余量）
  if (cachedToken && cachedToken.expiresAt - now > 5 * 60 * 1000) {
    return { ...credential, token: cachedToken.token };
  }

  // 2. 凭据自带过期时间，直接判断，省一次网络往返
  const exp = Number(credential.tokenExpiredTime);
  if (exp > 0 && exp - now > 5 * 60 * 1000) {
    cachedToken = { token: credential.token, expiresAt: exp };
    return credential;
  }

  // 3. 调用续期接口
  const fresh = await refreshImaToken(credential, log);
  if (!fresh) return credential;   // 失败退回原 token，由上游如实报错
  cachedToken = { token: fresh.token, expiresAt: now + fresh.tokenValidTime * 1000 };
  return { ...credential, token: fresh.token };
}
```

绝大多数请求走第 1 或第 2 级，不产生额外网络开销；仅临近过期时触发第 3 级。refreshToken 每次刷新滚动续期，该机制可无限期运行。

## 五、插件架构

### 5.1 目录结构

```
dsh-provider-ima/
├── package.json          dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      insert: llm-ima → dsh-provider-ima
└── lib/
    ├── index.js          插件入口：apply / inject / Config + PiAiAdapter
    └── ima-core.js       协议实现：bkn / 凭据 / 建档 / 续期 / SSE 翻译 / shim
```

`ima-core.js` 保持零外部依赖：DSH 家目录解析通过 `setDshHomeResolver()` 依赖注入，使该模块可脱离 DSH 环境独立单测。

### 5.2 转换链路

```
OpenAI 请求
   │
   ▼  lastUserText()      提取最后一条 user 文本
   ▼  ensureFreshToken()  有效性检查 / 自动续期
   ▼  initImaSession()    会话建档（首次）
   ▼  buildImaCookie() + imaBkn()   组装鉴权头
   │
   ▼  POST /cgi-bin/assistant/qa
   │
   ▼  createImaTranslator()
        ├─ blockMessage  → delta.content
        ├─ blockThinking → delta.reasoning_content
        └─ 其余          → 忽略
   │
   ▼  chat.completion.chunk 流
```

### 5.3 并发去重

DSH 会在同一毫秒并发发起多条请求（对话与自动生成会话标题）。`init_session` 未去重时，两个并发请求各自建档并互相覆盖，日志可见 25 毫秒内两次 `session created`。

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

实现中曾给 `session_id` 拼接序号后缀以图「每请求独立会话」。`session_id` 是服务端生成的受控格式，任何改写都会导致服务端不识别并返回空流 —— 该改动将原本偶发的竞态升级为必然失败。**服务端下发的标识符不应做任何加工。**

### 5.4 DSH 集成

插件需通过 profile 的显式清单注册，仅放入 `node_modules` 不生效：

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

`patchReload: "live"` 仅对 `cordis.patch.yml` 的热重载生效；**插件 JS 代码变更需重启 DSH 进程**。文件已更新但进程仍运行旧模块，会造成「修改无效」的假象。

## 六、未闭环的准入问题

### 6.1 现象

实现过程中 `assistant/qa` 开始恒定返回如下响应（固定 249 字节）：

```
event: COMPLETED
data: {"Code":3,"Msg":"","MsgSeqID":"",
       "IntentReportID":{"FirstID":0,"SecondID":0,"ThirdID":0},
       "DebugProfile":{"TraceID":"","会话ID":"","RobotType":0,"关键步骤列表":null}}

event: CLOSE
data: [DONE]
```

`DebugProfile` 全为空值：`TraceID`、`会话ID` 为空字符串，`RobotType` 为 0（请求中明确传入 `robot_type: 10000`）。响应中不出现 `QA_START`，而正常响应的首事件必然为它。

这些特征指向同一结论：**请求在路由到 QA 服务前已终止，请求体未被解析。**

### 6.2 排除项

| 假设 | 验证方法 | 结论 |
|---|---|---|
| token 过期 | 用 `auth_login/refresh` 换出全新 token 后立即请求 | 排除 |
| 会话未建档 | `init_session` 返回 `code:0` 及合法 `session_id` | 排除 |
| 请求体字段缺失 | 逐字段二分；补回 `model_info`/`history_info`/`client_tools` | 排除 |
| `client_id` 格式 | 尝试 UUID、抓包原值、`sid + 后缀` 三种形态 | 排除 |
| 缺少设备指纹 | 用 QimeiWeb 生成真实 `uskey` 并完整传入 `device_info` | 排除 |
| 网络指纹 / WAF | 在浏览器页面内用 `fetch` 直发（真 TLS 指纹、真同源） | 排除 |
| 鉴权头不完整 | 补齐 `User-Agent`、`sec-ch-ua` 系列、`traceparent` | 排除 |
| 接口下线 | 同一 token 调用 `init_session` 正常返回 | 排除 |

第二项的对照关系是：`init_session` 与 `assistant/qa` 使用**完全相同的鉴权头**，前者通过而后者被拒 —— 问题不在鉴权层。

### 6.3 与客户端协议的对比

同账号在桌面客户端工作正常，但两者协议完全不同：

| | Web API | 桌面客户端 |
|---|---|---|
| 协议 | HTTPS `POST /cgi-bin/assistant/qa` | MSF 二进制私有协议 |
| 连接 | 短连接 | 443 端口长连接 |
| 认证 | `x-ima-cookie` + `x-ima-bkn` | SSO 握手令牌（内存态） |

客户端进程的实际连接地址：

```
60.29.242.141:443
60.29.232.22:443
116.130.223.156:443
```

与 `imsdk_config` 中记录的 SSO 地址池（`60.29.232.85` / `60.29.232.121` / `220.194.118.231` 等）属同一网段。

### 6.4 客户端凭据不可提取

客户端 IM SDK 数据位于 `imsdk/`：

```
im.db         SQLite —— userinfo / userconfig / session / idcache
msg_0.db      SQLite —— message
imsdk_config  连接配置 —— 服务器 IP 池、设备 ID、账号，无凭据
```

`userconfig` 表中的 `synchronize_c2c_cookie`（28 字节）经解码为 protobuf 编码的**同步游标**：

```
hex: 08ac8ae9d506 10a2d7e9d506 28cbb1d6a801 38e6a6f5c8aaecefea18
     └ field1       └ field2      └ field5      └ field7
     (时间戳)        (时间戳)       (序号)         (时间戳)
```

非认证令牌。客户端的认证凭据**不落盘**，仅存在于长连接会话状态中。

### 6.5 扩展通道的能力边界

ima 为扩展提供自定义权限 `imaFrame`，可调用 `chrome.imaFrame.invoke({action, params})`。完整能力面：

```
方法：  invoke / invokeWithCallback / callbackFromNative
事件：  onAIMessage / onAttachmentProgress / onAudioPlayStatusChange / ...
动作：  closeUrlSidePanel / openSidePanelWithUrl / log / checkWasmValid
        getSystemState / setTranslateIconState / qa_tts / screenShot
        runAction / getMeta / mindmap_viewer_edit_action
```

全部为 UI 控制类接口，不存在提交问题给模型的能力。最接近的 `qa_tts` 仅用于对已有回答做语音合成。

### 6.6 判断

排除上述因素后，最可能的解释是账号级调用频次风控。时间线：

| 时间 | 事件 |
|---|---|
| 前期 | 8 个模型逐个实测，全部返回正常正文 |
| 之后约 20 分钟 | 密集发起 60+ 次请求 |
| 此后 | 相同构造、相同 token 的请求恒定返回 `Code=3` |

同代码从可用变为不可用，期间唯一变量为请求频次。

## 七、结论

| 项目 | 状态 |
|---|---|
| 端点与调用链识别 | 完成 |
| `x-ima-bkn` 算法还原 | 完成（逐位一致） |
| SSE 协议解析（含思维链） | 完成 |
| 模型编号表（8 个） | 完成（实测确认） |
| `uskey` 本地生成 | 完成 |
| token 自动续期 | 完成并验证 |
| 插件实现与 DSH 集成 | 完成 |
| `qa` 接口实际调用 | 受阻（服务端 `Code=3`） |

在凭据提取方式上，ima 与 workbuddy / qoder 存在本质差异：

| | workbuddy | qoder | ima |
|---|---|---|---|
| 凭据落盘 | 是（明文文件） | 是（数据文件） | 否（仅内存态） |
| 提取方式 | 读文件 | 读文件 | 需从浏览器登录态导出 |

差异源于产品形态：ima 是 IM 客户端，凭据服务于长连接握手，按安全实践不落盘；workbuddy / qoder 是工具类应用，凭据需跨进程复用。

## 附录 A：源码位置

```
examples/dsh-provider-ima/
├── package.json
├── cordis.patch.yml
├── README.md              使用文档
└── lib/
    ├── index.js           插件入口（apply / inject / Config + PiAiAdapter）
    └── ima-core.js        协议实现（bkn / 凭据 / 建档 / 续期 / SSE 翻译 / shim）
```

仓库地址：<https://github.com/tom613951/AstroPaper/tree/main/examples/dsh-provider-ima>

## 附录 B：核心算法与常量

```js
function imaBkn(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i += 1) h += (h << 5) + token.charCodeAt(i);
  return h & 0x7fffffff;
}

const IMA_ORIGIN       = "https://ima.qq.com";
const IMA_INIT_PATH    = "/cgi-bin/session_logic/init_session";
const IMA_QA_PATH      = "/cgi-bin/assistant/qa";
const IMA_REFRESH_PATH = "/cgi-bin/auth_login/refresh";
const IMA_MODELS_PATH  = "/cgi-bin/model_manage/get_models";
const IMA_ROBOT_TYPE   = 10000;   // 0 会被判为机器人通道
```

## 附录 C：错误码

| 错误码 | 出现位置 | 含义 |
|---|---|---|
| `code: 0` | `init_session` / `refresh` | 成功 |
| `code: 51` | `auth_login/refresh` | 参数校验失败（如缺 `userId`） |
| `code: 200201` | `session_logic/get_session` | 会话不存在 |
| `Code: 3` | `assistant/qa` | 业务拒绝（准入层，未进入 QA 服务） |

## 附录 D：参考资料

- 目标站点：https://ima.qq.com/chat
- 抓包工具：Chrome DevTools Protocol（`Network` domain）
- 参考实现：`dsh-workbuddy-connect`、`dsh-provider-qoder`
