# dsh-provider-ima

把腾讯 **ima**（https://ima.qq.com/）「问问ima」模块里的免费模型接入 DeepSeek Harness。

架构与 `dsh-workbuddy-connect` / `dsh-provider-qoder` 同构：插件在 loopback 上起一个 HTTP shim，
pi-ai 把 OpenAI Chat Completions 请求发到这里，shim 翻译成 ima 的 SSE 协议再译回 OpenAI chunk 流。

**凭据只需写入一次，插件自动用 refreshToken 滚动续期，ima 桌面端无需常驻。**

---

## 快速开始

### 1. 取得凭据（一次性，refreshToken 30 天有效）

打开 https://ima.qq.com/chat 并登录，F12 → Console 执行：

```js
JSON.parse(localStorage.getItem("ima-universal-local-storage-accountInfo"))
```

把 `token` / `refreshToken` / `uid` / `guid` / `idType` / `tokenType` 抄进 `{DSH_HOME}/ima/ima-credential.json`：

```json
{
  "token": "<IMA-TOKEN>",
  "refreshToken": "<IMA-REFRESH-TOKEN>",
  "uid": "001a8d9235803999",
  "guid": "guid-1a91c123418100519a9bf8d7e76037a5eb4c3ef1fe",
  "idType": "2",
  "tokenType": "14"
}
```

可选加上 `tokenExpiredTime` / `refreshTokenExpiredTime`（毫秒时间戳），插件能少打一次 refresh。

### 2. 安装插件

```powershell
Copy-Item -Recurse .\dsh-provider-ima "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\"
```

然后在 `{DSH_HOME}/profiles/desktop/package.json` 里**两处**都加上：

```json
{ "dependencies": { "dsh-provider-ima": "0.1.0" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-provider-ima" ] } } }
```

> **关键**：DSH 靠 `dsh.profile.bundles` 显式清单发现插件，只放 `node_modules` 不生效。

### 3. 重启 DSH

插件 JS 变更需要重启进程（`patchReload: "live"` 只对 `cordis.patch.yml` 生效）。

---

## 可用模型

| DSH 模型名 | ima model_type | 思维链 |
|---|---|---|
| ds-v4-flash-fast | 3 | — |
| ds-v4-flash-think | 1 | 是 |
| hy3-fast | 0 | — |
| hy3-think | 2 | 是 |
| hy4-preview-fast | 1001 | — |
| hy4-preview-think | 1002 | 是 |
| glm-5.3-flash-fast | 3000 | — |
| glm-5.3-flash-think | 3001 | 是 |

「深度」系列通过 `delta.reasoning_content` 输出思维链。
模型表可用 `flattenImaModels()` 从 `POST /cgi-bin/model_manage/get_models` 动态刷新。

---

## 协议要点（逆向结论）

### 端点

```
POST /cgi-bin/session_logic/init_session     建档 → 返回服务端生成的 session_id
POST /cgi-bin/assistant/qa                   SSE 问答
POST /cgi-bin/auth_login/refresh             token 续期
POST /cgi-bin/model_manage/get_models        模型目录
```

### 鉴权（全部本地可算，无 captcha）

```js
// DJB2 变体，已实证与抓包逐位一致
function imaBkn(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h += (h << 5) + token.charCodeAt(i);
  return h & 0x7fffffff;
}
```

请求头：`from_browser_ima: 1`、`x-ima-bkn: <上面的值>`、`x-ima-cookie: <见下>`

```
x-ima-cookie =
  PLATFORM=H5; CLIENT-TYPE=256053; WEB-VERSION=999.999.999;
  IMA-GUID=<guid>; IMA-Q36=<guid 去掉 guid- 前缀>; IMA-UID=<uid>;
  IMA-TOKEN=<token>; IMA-REFRESH-TOKEN=<refreshToken>;
  UID-TYPE=<idType>; TOKEN-TYPE=<tokenType>
```

### 问答题（三个必须踩对的坑）

```json
{
  "session_id": "<init_session 返回的>",
  "robot_type": 10000,
  "question": "裸字符串",
  "question_type": 3,
  "model_type": 3,
  "client_id": "...", "trace_id": "...", "offset": 0
}
```

- **`robot_type` 必须 10000** —— 传 0 会被判为机器人通道直接拒答
- **`question` 必须是字符串** —— 传 `{content:...}` 会得到空流
- **`session_id` 必须来自 `init_session`** —— 服务端不认客户端自造的 id；只发 qa 不先建档会拿到 HTTP 200 但仅含 COMPLETED/CLOSE 的空流

### token 续期

```json
{ "userId": "<uid>", "refreshToken": "<...>" }

→ { "code": 0, "token": "<新token>", "token_valid_time": "7200", "user_id": "..." }
```

> **字段必须小驼峰** `userId` —— 服务端 protobuf 类型叫 `RefreshReq.UserId`，但 JSON 要写 `userId`（PascalCase 会报 `invalid RefreshReq.UserId`）。

`IMA-TOKEN` 仅 2 小时有效，但 `refreshToken` 有 30 天且**每次刷新滚动续期** —— 这是长期可用的基础。

### SSE 事件

| event | 说明 |
|---|---|
| QA_START | 开始，回显 model_type / trace_id |
| SESSION_START | MsgSeqID |
| STRUCTURED_BLOCK | 正文载体 |
| HEARTBEAT / SUGGEST_QUESTION / ATTACHED_BLOCK | 附属 |
| COMPLETED / CLOSE | 结束 |

`STRUCTURED_BLOCK` 的块类型：

| Type | 字段 | 映射到 |
|---|---|---|
| blockMessage | Data.text_message.Text | delta.content |
| blockThinking | Data.thinking_message.Message | delta.reasoning_content |
| loading | — | 忽略 |

---

## 已知限制

### `qa` 接口可能返回 `Code=3`

```json
{"Code":3,"Msg":"","MsgSeqID":"","DebugProfile":{"TraceID":"","会话ID":"","RobotType":0}}
```

恒定 249 字节，且**不出现 `QA_START`** —— 请求在路由到 QA 服务前就被终止。

已验证**与此无关**的因素（全部排除）：

- token 有效性（刚 refresh 出的新 token 一样失败）
- `init_session`（正常返回 `code:0` + `session_id`）
- 请求构造（逐字段二分；同一构造早前成功过）
- 网络指纹（浏览器页面内 fetch 直发同样失败；Node、完整浏览器头都试过）
- `client_id` 格式、`device_info.uskey`、`history_info`、`client_tools`（全部补过）

**反直觉的事实**：同一账号在 ima 客户端里完全正常，而 Web API 通道返回 `Code=3`。
两者走**完全不同的协议**：

| | Web API（插件用的） | 客户端 |
|---|---|---|
| 协议 | HTTPS `/cgi-bin/assistant/qa` | MSF 二进制私有协议（443 长连接） |
| 认证 | `x-ima-cookie` + `x-ima-bkn` | SSO 握手令牌（内存态，不落盘） |

客户端的凭据**不落盘**（`imsdk` 目录只有 SQLite 消息库 + 连接配置，无 token），
因此无法像 `dsh-provider-qoder`（读 `auth.v1.dat`）/ `dsh-workbuddy-connect`
（读 `workbuddy-desktop.info`）那样「读一次文件长期使用」。

### 可能的原因与对策

最可能是**账号级调用频次风控** —— 排查期间短时间发了 60+ 次请求。若是，冷却后应自行恢复。

```powershell
node check-ima-quota.mjs    # ✅ 问答权限正常 / ❌ 仍被限制 Code = 3
```

---

## 文件结构

```
dsh-provider-ima/
├── package.json
├── cordis.patch.yml          insert: llm-ima → dsh-provider-ima
└── lib/
    ├── index.js              apply / inject / Config + PiAiAdapter + INERT_AUTH
    └── ima-core.js           bkn + 凭据 + init_session + refresh + SSE 翻译 + shim
```

## 导出接口（lib/ima-core.js）

```js
imaBkn(token)                          // DJB2 → x-ima-bkn
buildImaCookie(credential)             // 组装 x-ima-cookie
parseImaCredential(text)               // 容错解析（JSON 或裸 token）
readImaCredential() / writeImaCredential() / imaCredentialPath()
setDshHomeResolver(fn)                 // 依赖注入，模块零外部依赖
initImaSession(credential, log)        // 建档 → session_id
refreshImaToken(credential, log)       // 续期 → { token, tokenValidTime }
flattenImaModels(payload)              // get_models 响应 → 模型表
lastUserText(messages)                 // 提取最后一条 user 文本
createImaTranslator(...)               // ima SSE → OpenAI chunk
createImaShim({ resolveCredential, logger })
hostIsLoopback(host) / writeOpenAIError(res, status, code, message)
```

## 上游依据

全部来自对 `https://ima.qq.com/chat` 的 CDP 抓包与 JS 逆向（详见同目录 `IMA_SPEC.md`）：

- bkn 算法：`ima_awesome.js` 的 `Pg`（导出链 `g` ← `awesome-BVSLqIPa.js`）
- 模型表：`POST /cgi-bin/model_manage/get_models` 实测
- SSE 结构：`POST /cgi-bin/assistant/qa` 实测
- 请求体形态：CDP `get_cdp_request_post_data` 抓取

## License

MIT
