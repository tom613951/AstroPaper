/**
 * dsh-provider-ima — 把腾讯 ima「问问ima」里的免费模型接入 DeepSeek Harness。
 *
 * 架构与 dsh-workbuddy-connect 一致：本插件在 loopback 上起一个小 HTTP shim，
 * 由它把 pi-ai 发来的 OpenAI Chat Completions 请求翻译成 ima 的
 * POST /cgi-bin/assistant/qa（SSE），再把 ima 的 STRUCTURED_BLOCK 事件流
 * 翻译回 OpenAI 的 chat.completion.chunk 流。
 *
 * 凭据只在每次请求时由 resolveCredential 取用；ima 桌面端本身不需要常驻。
 */

import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";


//#region 常量

export const IMA_PROVIDER_ID = "ima";
export const IMA_DISPLAY_NAME = "ima";
export const IMA_CONNECT_VERSION = "0.1.0";

const IMA_ORIGIN = "https://ima.qq.com";
const IMA_QA_PATH = "/cgi-bin/assistant/qa";
const IMA_STREAM_PATH = "/cgi-bin/assistant/get_stream";
const IMA_INIT_PATH = "/cgi-bin/session_logic/init_session";
const IMA_REFRESH_PATH = "/cgi-bin/auth_login/refresh";

// 问问ima 的用户通道标识。robot_type=0 会被服务端判为机器人通道，
// 直接返回空流（HTTP 200 但只有 COMPLETED/CLOSE），必须用 10000。
const IMA_ROBOT_TYPE = 10000;

export const IMA_STREAM_IDLE_TIMEOUT_MS = 120000;
export const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** ima 的模型枚举（Pt），来自网页版 bundle。id 即请求体的 model_type。 */
// 模型表来源：POST /cgi-bin/model_manage/get_models（2026-09-28 实测）
// 一个「模型组」含 快速(instruct) / 深度(thinking) 两套编号，UI 的思考模式开关即切换它。
// mode 字段即 get_models 的 sub_model_infos 键："0"=快速，"1"=深度。
export const IMA_MODELS = [
  { id: 3,    key: "ds-v4-flash-fast",   name: "DeepSeek-V4-Flash (快速)",   group: "DeepSeek-V4-Flash", mode: "快速", contextWindow: 128000, maxTokens: 8192 },
  { id: 1,    key: "ds-v4-flash-think",  name: "DeepSeek-V4-Flash (深度)",   group: "DeepSeek-V4-Flash", mode: "深度", contextWindow: 128000, maxTokens: 8192 },
  { id: 0,    key: "hy3-fast",           name: "Hy3 (快速)",                 group: "Hy3",               mode: "快速", contextWindow: 128000, maxTokens: 8192 },
  { id: 2,    key: "hy3-think",          name: "Hy3 (深度)",                 group: "Hy3",               mode: "深度", contextWindow: 128000, maxTokens: 8192 },
  { id: 1001, key: "hy4-preview-fast",   name: "Hy4 preview (快速)",         group: "Hy4 preview",       mode: "快速", contextWindow: 128000, maxTokens: 8192 },
  { id: 1002, key: "hy4-preview-think",  name: "Hy4 preview (深度)",         group: "Hy4 preview",       mode: "深度", contextWindow: 128000, maxTokens: 8192 },
  { id: 3000, key: "glm-5.3-flash-fast", name: "GLM-5.3-Flash (快速)",       group: "GLM-5.3-Flash",     mode: "快速", contextWindow: 128000, maxTokens: 8192 },
  { id: 3001, key: "glm-5.3-flash-think",name: "GLM-5.3-Flash (深度)",       group: "GLM-5.3-Flash",     mode: "深度", contextWindow: 128000, maxTokens: 8192 },
];

// get_models 接口路径与模型组结构（供运行时动态刷新用）
export const IMA_MODELS_PATH = "/cgi-bin/model_manage/get_models";

/**
 * 把 get_models 的原始响应拍平成 IMA_MODELS 形态。
 * 每个模型组的 sub_model_infos["0"]=快速 / ["1"]=深度。
 */
export function flattenImaModels(payload) {
  const out = [];
  const models = payload?.models ?? [];
  for (const g of models) {
    const subs = g?.sub_model_infos ?? g?.subModelInfos ?? {};
    const group = String(g?.model_name ?? '');
    const short = String(g?.short_model_name ?? '');
    const modes = [["0", "快速"], ["1", "深度"]];
    for (const [k, label] of modes) {
      const s = subs[k];
      if (!s) continue;
      const id = Number(s.model_type ?? s.modelType);
      if (!Number.isFinite(id)) continue;
      out.push({ id, key: (short || group).toLowerCase().replace(/[^a-z0-9.]+/g, '-') + '-' + (k === '0' ? 'fast' : 'think'),
        name: `${group} (${label})`, group, mode: label, shortName: short,
        contextWindow: 128000, maxTokens: 8192 });
    }
  }
  return out;
}

//#endregion

//#region bkn 签名（DJB2）

/**
 * ima 的 x-ima-bkn 头：对 IMA-TOKEN 做 DJB2，再截成 31 位正整数。
 * 逆向自 ima 前端（ima_awesome.js），已对真实 token 实证命中。
 */
export function imaBkn(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i += 1) h += (h << 5) + token.charCodeAt(i);
  return h & 0x7fffffff;
}

//#endregion

//#region 凭据

const IMA_CREDENTIAL_FILENAME = "ima-credential.json";

let dshHomeResolver = null;

/** DSH 侧在启动时注入 resolveDshHome（避免离线单测依赖）。 */
export function setDshHomeResolver(fn) { dshHomeResolver = fn; }

export function imaCredentialPath() {
  const home = dshHomeResolver ? dshHomeResolver() : join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh");
  return join(home, "ima", IMA_CREDENTIAL_FILENAME);
}

export function parseImaCredential(text) {
  const trimmed = String(text == null ? "" : text).trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && typeof parsed.token === "string") {
      const token = parsed.token.trim();
      if (token.length > 0) {
        return {
          token,
          uid: typeof parsed.uid === "string" ? parsed.uid.trim() : "",
          guid: typeof parsed.guid === "string" ? parsed.guid.trim() : "",
          refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken.trim() : "",
        };
      }
    }
  } catch {
    // 不是 JSON：当成裸 token 处理
  }
  return { token: trimmed, uid: "", guid: "", refreshToken: "" };
}

export function readImaCredential() {
  const p = imaCredentialPath();
  if (!existsSync(p)) return undefined;
  try { return parseImaCredential(readFileSync(p, "utf8")); } catch { return undefined; }
}

export function writeImaCredential(credential) {
  const p = imaCredentialPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(credential, null, 2) + "\n", { encoding: "utf8", mode: 384 });
  return p;
}

/** 拼 ima 需要的 x-ima-cookie 头。 */
export function buildImaCookie(credential) {
  const guid = credential.guid || credential.uid || "";
  const parts = [
    "PLATFORM=H5",
    "CLIENT-TYPE=256053",
    "WEB-VERSION=999.999.999",
    "IMA-GUID=guid-" + guid,
    "IMA-Q36=" + guid,
  ];
  if (credential.uid) parts.push("IMA-UID=" + credential.uid);
  parts.push("IMA-TOKEN=" + credential.token);
  if (credential.refreshToken) parts.push("IMA-REFRESH-TOKEN=" + credential.refreshToken);
  parts.push("UID-TYPE=2", "TOKEN-TYPE=14");
  return parts.join("; ");
}

//#endregion

//#region shim 工具

export function hostIsLoopback(host) {
  if (typeof host !== "string") return false;
  const h = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export function writeOpenAIError(res, status, code, message) {
  writeJson(res, status, { error: { message, type: "invalid_request_error", code } });
}

function writeSse(res, data) {
  res.write("data: " + JSON.stringify(data) + "\n\n");
}

/** 从 OpenAI 请求里抽出最后一条用户文本。 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.filter(function (p) { return p && p.type === "text" && typeof p.text === "string"; })
        .map(function (p) { return p.text; }).join("\n");
    }
  }
  return "";
}

/** ima 的会话建档接口：服务端只对已建档的 session_id 返回内容。 */
const IMA_SESSION_PATH = "/cgi-bin/session_logic/get_session";

/**
 * 客户端格式的会话 id：固定前缀 "6aba" + 30 位十六进制（共 34 字符）。
 * 网页版就是这么生成的，服务端不做格式校验，但随后的建档必须走 get_session。
 */
export function newImaSessionId() {
  return "6aba" + randomBytes(15).toString("hex");
}

/**
 * 把本地生成的 session_id 注册到 ima 服务端。
 * 不做这一步时 /assistant/qa 会返回 HTTP 200 但 SSE 流为空（只有 QA_START/CLOSE）。
 */
// token 内存缓存：避免每个请求都打 refresh 接口
let cachedToken = null;        // { token, expiresAt }

/**
 * 保证 token 新鲜：本地缓存的 token 还剩 >5 分钟就直接用，否则用 refreshToken 换新的。
 * 刷新失败时退回原 token（让上游报错，不静默失败）。
 */
async function ensureFreshToken(credential, log) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > 5 * 60 * 1000) {
    return Object.assign({}, credential, { token: cachedToken.token });
  }
  // 落盘凭据里带了过期时间就直接判断，省一次网络往返
  const expRaw = Number(credential.tokenExpiredTime);
  const expMs = Number.isFinite(expRaw) && expRaw > 0 ? (expRaw > 1e12 ? expRaw : expRaw * 1000) : 0;
  if (expMs > 0 && expMs - now > 5 * 60 * 1000 && credential.token !== (cachedToken && cachedToken.token)) {
    cachedToken = { token: credential.token, expiresAt: expMs };
    return credential;
  }
  const fresh = await refreshImaToken(credential, log);
  if (!fresh) return credential;
  cachedToken = { token: fresh.token, expiresAt: now + fresh.tokenValidTime * 1000 };
  return Object.assign({}, credential, { token: fresh.token });
}

/**
 * 用 refreshToken 换新 token。ima 的 IMA-TOKEN 只有 2 小时寿命，
 * 但 refreshToken 有 30 天且每次刷新会滚动续期 —— 这是「读一次配置长期使用」的关键。
 *
 * ★ 字段名必须是小驼峰 userId / refreshToken：服务端 protobuf 类型叫 RefreshReq.UserId，
 *   但 JSON 序列化用小驼峰（PascalCase 会报 invalid RefreshReq.UserId）。
 */
export async function refreshImaToken(credential, log) {
  if (!credential || !credential.token || !credential.uid || !credential.refreshToken) return null;
  try {
    const res = await fetch(IMA_ORIGIN + IMA_REFRESH_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        from_browser_ima: "1",
        "x-ima-bkn": String(imaBkn(credential.token)),
        "x-ima-cookie": buildImaCookie(credential),
        origin: IMA_ORIGIN,
        referer: IMA_ORIGIN + "/",
      },
      body: JSON.stringify({ userId: credential.uid, refreshToken: credential.refreshToken }),
    });
    const data = await res.json().catch(function () { return null; });
    if (!data || data.code !== 0 || !data.token) {
      if (log) log.warn("[ima] token refresh failed: " + JSON.stringify(data).slice(0, 200));
      return null;
    }
    if (log) log.info("[ima] token refreshed, valid " + (data.token_valid_time || "?") + "s");
    return { token: data.token, tokenValidTime: Number(data.token_valid_time) || 7200 };
  } catch (err) {
    if (log) log.warn("[ima] token refresh error: " + (err && err.message));
    return null;
  }
}

/**
 * 向 ima 申请一个新会话，返回服务端生成的 session_id。
 * ★ 服务端不认客户端自造的 id：必须先 init_session 建档，否则 /assistant/qa
 *   会返回 HTTP 200 但只有 COMPLETED/CLOSE 的空流。
 */
export async function initImaSession(credential, log) {
  try {
    const res = await fetch(IMA_ORIGIN + IMA_INIT_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        from_browser_ima: "1",
        "x-ima-bkn": String(imaBkn(credential.token)),
        "x-ima-cookie": buildImaCookie(credential),
        origin: IMA_ORIGIN,
        referer: IMA_ORIGIN + "/",
      },
      body: JSON.stringify({
        name: "",
        sessionType: 0,
        envInfo: { robotType: IMA_ROBOT_TYPE, interactType: 2 },
        msgsLimit: 10,
      }),
    });
    const data = await res.json().catch(function () { return null; });
    const id = data && data.session_id;
    if (id) {
      if (log) log.info("[ima] session created: " + id);
      return id;
    }
    if (log) log.warn("[ima] init_session failed: " + JSON.stringify(data).slice(0, 200));
    return "";
  } catch (err) {
    if (log) log.warn("[ima] init_session error: " + (err && err.message));
    return "";
  }
}

/** 把 ima 的 SSE 事件流翻译成 OpenAI chat.completion.chunk 流。 */
export function createImaTranslator(modelKey, res, sessionId, onDone) {
  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model: modelKey };
  const send = function (delta, finish) {
    writeSse(res, { id, object: "chat.completion.chunk", created, model: modelKey,
      choices: [{ index: 0, delta, finish_reason: finish === undefined ? null : finish }] });
  };
  send({ role: "assistant", content: "" }, null);
  return {
    base,
    sessionId,
    /**
     * ima 的块类型：
     *   blockMessage  → 正文（Data.text_message.Text）
     *   blockThinking → 思维链（Data.thinking_message.Message）
     *   loading / qaDownloadGuide / 其余 → 忽略
     */
    push(eventName, dataText) {
      if (eventName !== "STRUCTURED_BLOCK") return false;
      let parsed;
      try { parsed = JSON.parse(dataText); } catch { return false; }
      if (!parsed || !parsed.Data) return false;
      if (parsed.Type === "blockMessage") {
        const msg = parsed.Data.text_message || parsed.Data.textMessage;
        const text = msg ? msg.Text : "";
        if (typeof text === "string" && text.length > 0) { send({ content: text }, null); return true; }
        return false;
      }
      if (parsed.Type === "blockThinking") {
        const th = parsed.Data.thinking_message || parsed.Data.thinkingMessage;
        const text = th ? th.Message : "";
        if (typeof text === "string" && text.length > 0) { send({ reasoning_content: text }, null); return true; }
        return false;
      }
      return false;
    },
    finish() {
      send({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      if (onDone) onDone();
    },
    fail(message) {
      send({ content: "\n\n[ima] " + message }, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      if (onDone) onDone();
    },
  };
}

//#endregion

//#region shim

export function createImaShim(options) {
  const resolveCredential = options.resolveCredential;
  const logger = options.logger;

  const server = createServer(function (req, res) {
    handle(req, res).catch(function (error) {
      if (logger && logger.error) logger.error("dsh-provider-ima: shim request failed", error);
      if (!res.headersSent) writeOpenAIError(res, 500, "internal_error", String(error && error.message ? error.message : error));
    });
  });

  // ★ 并发防护：DSH 会在同一毫秒并发发多条请求（对话 + 自动起标题）。
  //   initPromise 去重，保证只建一次 session，避免两次 init_session 互相覆盖。
  //   注意：session_id 是服务端生成的受控格式，绝不可拼接/改写。
  let initPromise = null;

  function acquireSession(credential) {
    if (initPromise === null) {
      initPromise = initImaSession(credential, logger).then(function (sid) {
        if (!sid) initPromise = null;   // 失败允许下次重试
        return sid;
      }, function (e) {
        initPromise = null;
        throw e;
      });
    }
    return initPromise;
  }

  const ready = new Promise(function (resolve, reject) {
    server.once("listening", function () { resolve(); });
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");

  function baseUrl() {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("ima shim has no listening address");
    return "http://127.0.0.1:" + address.port;
  }

  async function handle(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      return writeOpenAIError(res, 403, "host_not_allowed", "ima shim only serves loopback callers");
    }
    const url = new URL(req.url == null ? "/" : req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return writeJson(res, 200, {
        object: "list",
        data: IMA_MODELS.map(function (m) { return { id: m.key, object: "model", owned_by: "ima" }; }),
      });
    }

    if (req.method !== "POST" || url.pathname.indexOf("/chat/completions") < 0) {
      return writeOpenAIError(res, 404, "not_found", "unknown ima shim route " + url.pathname);
    }

    const raw = await new Promise(function (resolve, reject) {
      const chunks = [];
      req.on("data", function (c) { chunks.push(c); });
      req.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
      req.on("error", reject);
    });

    let payload;
    try { payload = JSON.parse(raw || "{}"); }
    catch { return writeOpenAIError(res, 400, "invalid_json", "request body is not JSON"); }

    let credential = await resolveCredential();
    if (!credential || !credential.token) {
      return writeOpenAIError(res, 401, "no_credential", "no ima credential available");
    }
    // ★ token 只剩 5 分钟有余时提前刷新（IMA-TOKEN 只有 2 小时寿命）
    credential = await ensureFreshToken(credential, logger);

    const modelKey = typeof payload.model === "string" ? payload.model : IMA_MODELS[0].key;
    const model = IMA_MODELS.find(function (m) { return m.key === modelKey; }) || IMA_MODELS[0];
    const question = lastUserText(payload.messages);
    if (question.length === 0) return writeOpenAIError(res, 400, "empty_question", "no user message found");

    let sessionId = await acquireSession(credential);
    if (!sessionId) return writeOpenAIError(res, 502, "upstream_error", "ima: init_session failed");

    const upstream = await fetch(IMA_ORIGIN + IMA_QA_PATH, {
      method: "POST",
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        accept: "text/event-stream",
        from_browser_ima: "1",
        "x-ima-bkn": String(imaBkn(credential.token)),
        "x-ima-cookie": buildImaCookie(credential),
        origin: IMA_ORIGIN,
        referer: IMA_ORIGIN + "/chat",
      },
      body: JSON.stringify({
        session_id: sessionId,
        question,
        question_type: 3,
        client_id: sessionId + "-client",
        robot_type: IMA_ROBOT_TYPE,
        trace_id: randomUUID().replace(/-/g, ""),
        offset: 0,
        history_info: { type: 0 },
        model_info: { model_id: "official_" + model.id, model_type: model.id, enable_enhancement: true },
        client_tools: [],
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(function () { return ""; });
      return writeOpenAIError(res, upstream.status || 502, "upstream_error",
        "ima upstream returned " + upstream.status + ": " + text.slice(0, 400));
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const translator = createImaTranslator(modelKey, res, sessionId);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "";

    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
          if (line.startsWith("data:")) translator.push(eventName, line.slice(5).trim());
        }
      }
      translator.finish();
    } catch (error) {
      if (logger && logger.error) logger.error("dsh-provider-ima: upstream stream failed", error);
      translator.fail(String(error && error.message ? error.message : error));
    }
  }

  return {
    ready,
    baseUrl,
    close: function () { server.close(); },
    port: function () { const a = server.address(); return a && typeof a === "object" ? a.port : 0; },
  };
}

//#endregion
