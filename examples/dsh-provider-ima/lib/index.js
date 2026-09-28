/**
 * dsh-provider-ima — 把腾讯 ima「问问ima」里的免费模型接入 DeepSeek Harness。
 *
 * 与 dsh-workbuddy-connect 同构：插件在 loopback 上起一个 HTTP shim，
 * pi-ai 把 OpenAI Chat Completions 请求发到这里，shim 翻译成 ima 的
 * POST /cgi-bin/assistant/qa（SSE），再把 ima 的 STRUCTURED_BLOCK 事件
 * 翻译回 OpenAI 的 chat.completion.chunk 流。
 *
 * 凭据一次性读取后长期复用，ima 桌面端不需要常驻。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import {
  IMA_PROVIDER_ID,
  IMA_DISPLAY_NAME,
  IMA_MODELS,
  IMA_STREAM_IDLE_TIMEOUT_MS,
  NO_COST,
  createImaShim,
  readImaCredential,
  writeImaCredential,
  parseImaCredential,
  imaCredentialPath,
  setDshHomeResolver,
} from "./ima-core.js";

setDshHomeResolver(resolveDshHome);

//#region 设置

const credentialFileField = z.string().default("")
  .description("IMA-TOKEN 凭据文件路径；留空则使用 DSH 家目录下的 ima/ima-credential.json");

const Config = z.object({
  credentialFile: credentialFileField,
});

//#endregion

//#region pi-ai 描述符

/** 把一个 ima 模型转成指向 loopback shim 的 pi-ai 描述符。 */
export function toPiModel(info, baseUrl, providerId) {
  return {
    id: info.key,
    name: info.name,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    input: ["text"],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: { maxTokensField: "max_tokens" },
  };
}

//#endregion

//#region 适配器

/** 禁用 pi-ai 自身的凭证发现：凭据由 shim 在转发时注入。 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error("dsh-provider-ima: the ima route has no pi-ai credential lifecycle"); },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false; },
  },
};

export function createImaAdapter(options) {
  const shim = options.shim;
  const providerId = options.providerId || IMA_PROVIDER_ID;
  const displayName = options.displayName || IMA_DISPLAY_NAME;

  const buildModels = function () {
    const baseUrl = shim.baseUrl() + "/v1";
    return IMA_MODELS.map(function (info) { return toPiModel(info, baseUrl, providerId); });
  };

  const provider = Object.assign(
    createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: "ima session token",
          async resolve(args) {
            const key = args && args.credential ? args.credential.key : undefined;
            if (key === undefined || String(key).length === 0) return undefined;
            return { auth: { apiKey: key }, source: "ima" };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    { getModels: function () { return buildModels(); } },
  );

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: IMA_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-provider-ima retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    piProvider: provider,
  };

  const profiles = new Map([[providerId, profile]]);

  const adapter = new PiAiAdapter({
    profiles: function () { return profiles; },
    auth: INERT_AUTH,
    resolveApiKey: async function () {
      const credential = options.resolveCredential ? await options.resolveCredential() : undefined;
      return credential && credential.token ? credential.token : undefined;
    },
  });

  return {
    adapter,
    provider,
    invalidate: function () {
      profile.piProvider = provider;
      profile.configuredMaxTokens = new Map();
      profile.modelErrors = new Map();
    },
  };
}

//#endregion

//#region 插件入口

export const name = "dsh-provider-ima";
export const inject = ["llm"];

export function apply(ctx, config) {
  let current = function () { return config; };
  let stopped = false;

  const customPath = function () {
    const c = current();
    const p = c && typeof c.credentialFile === "string" ? c.credentialFile.trim() : "";
    return p.length > 0 ? p : undefined;
  };

  const resolveCredential = async function () {
    const p = customPath();
    if (p && existsSync(p)) {
      try { return parseImaCredential(readFileSync(p, "utf8")); } catch { /* fall through */ }
    }
    return readImaCredential();
  };

  const shim = createImaShim({ resolveCredential, logger: ctx.logger });

  shim.ready.then(function () {
    if (stopped) { shim.close(); return; }
    const built = createImaAdapter({ shim, resolveCredential });
    let release;
    try {
      release = ctx.llm.registerAdapter([IMA_PROVIDER_ID], built.adapter);
    } catch (error) {
      ctx.logger.error("dsh-provider-ima: provider registration failed", error);
      shim.close();
      return;
    }
    ctx.effect(function () {
      return function () { release(); shim.close(); };
    });
    ctx.logger.info("dsh-provider-ima: registered on " + shim.baseUrl() + " with " + IMA_MODELS.length + " models");
  }).catch(function (error) {
    ctx.logger.error("dsh-provider-ima: loopback endpoint failed to start", error);
  });
}

//#endregion

export { Config, imaCredentialPath, writeImaCredential, parseImaCredential, readImaCredential };
