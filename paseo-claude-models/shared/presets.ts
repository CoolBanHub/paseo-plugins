/**
 * Built-in provider presets: verified Anthropic-compatible endpoints plus a
 * blank "custom" entry. A preset only seeds the form — every field (models
 * included) stays editable, because vendors rename model ids and offer new
 * ones faster than any plugin ships.
 */

export type ProviderProtocol = "anthropic" | "chat";
export type AuthHeader = "bearer" | "x-api-key";

export type PresetModel = {
  id: string;
  label: string;
  description?: string;
  contextWindow?: number;
};

export type ProviderPreset = {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authHeader: AuthHeader;
  models: PresetModel[];
  /** Where an API key comes from. */
  keyHint: string;
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek 开放平台 Anthropic 兼容端点",
    baseUrl: "https://api.deepseek.com/anthropic",
    protocol: "anthropic",
    authHeader: "bearer",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat", description: "V 系列通用模型", contextWindow: 131072 },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner", description: "R 系列推理模型", contextWindow: 131072 },
    ],
    keyHint: "platform.deepseek.com 创建 API Key",
  },
  {
    id: "glm",
    label: "GLM（智谱）",
    description: "智谱开放平台 Anthropic 兼容端点，支持 GLM Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    protocol: "anthropic",
    authHeader: "bearer",
    models: [
      { id: "glm-5.3", label: "GLM-5.3", description: "旗舰编程模型" },
      { id: "glm-4.6", label: "GLM-4.6", description: "上一代旗舰", contextWindow: 204800 },
      { id: "glm-4.5-air", label: "GLM-4.5-Air", description: "轻量高速", contextWindow: 204800 },
    ],
    keyHint: "open.bigmodel.cn 创建 API Key",
  },
  {
    id: "kimi",
    label: "Kimi（Moonshot）",
    description: "Moonshot Anthropic 兼容端点（国际站）",
    baseUrl: "https://api.moonshot.ai/anthropic",
    protocol: "anthropic",
    authHeader: "bearer",
    models: [
      { id: "kimi-k2.5", label: "Kimi K2.5", description: "K2 系列旗舰", contextWindow: 262144 },
      { id: "kimi-k2-0905-preview", label: "Kimi K2 0905", description: "K2 预览版", contextWindow: 262144 },
    ],
    keyHint: "platform.moonshot.ai 创建 API Key",
  },
  {
    id: "qwen",
    label: "通义千问",
    description: "阿里云百炼 Claude Code 代理端点",
    baseUrl: "https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy",
    protocol: "anthropic",
    authHeader: "bearer",
    models: [
      { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus", description: "编程旗舰", contextWindow: 262144 },
      { id: "qwen3-coder-flash", label: "Qwen3 Coder Flash", description: "编程高速版", contextWindow: 262144 },
    ],
    keyHint: "bailian.console.aliyun.com 创建 API Key",
  },
  {
    id: "custom",
    label: "自定义",
    description: "任意 Anthropic 或 OpenAI 兼容端点（vLLM、Ollama、OpenRouter 等）",
    baseUrl: "",
    protocol: "anthropic",
    authHeader: "bearer",
    models: [],
    keyHint: "填入端点提供方的 API Key",
  },
];
