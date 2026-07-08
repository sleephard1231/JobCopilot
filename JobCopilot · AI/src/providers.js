// ===== 自定义 LLM 端点(支持任意 OpenAI 兼容服务) =====
// 兼容:DeepSeek / OpenAI / OneAPI / 各种中转站 / 自部署代理 / Ollama / LM Studio 等
const PROVIDERS = {
  custom: {
    label: '🔧 自定义(任意 OpenAI 兼容端点)',
    customMode: true,
  }
};

const DEFAULT_PROVIDER = 'custom';
function getProviderCfg(key) { return PROVIDERS[key] || PROVIDERS[DEFAULT_PROVIDER]; }