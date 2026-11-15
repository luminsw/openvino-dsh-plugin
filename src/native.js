/**
 * native.js — 纯 Node 探测层：模型目录、OVMS 注册、OVI 产物文件，一律不依赖 python。
 *
 * 为什么要这一层：`openvino_status` / `openvino_models_scan` / `openvino_env_diag`
 * 需要的全部信息都能直接拿到——OVMS 注册走 HTTP `/v1/models`，本地模型目录走 `node:fs`，
 * 目录名↔服务 id 的映射本来就在 JS 里。把它们绑在 python 上，会让"本机没装 openvino
 * python 包"这种正常情况把状态查询一起打挂（曾经的表现是误导性的「未找到 python」）。
 *
 * python 只保留给真正需要 openvino bindings 的两件事：openvino_bench / openvino_convert。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 默认 OVMS 基地址（与 Config.ovmsUrl 默认值一致）。 */
export const DEFAULT_OVMS_URL = "http://127.0.0.1:8000";

/**
 * 解析模型目录：显式配置优先，其次 BAIHUA_HOME/models、~/.baihua/models、~/.openclaw/models。
 * @param {string} [configured] - Config.modelsDir 或工具参数。
 * @returns {string|null} 存在的目录，找不到返回 null。
 */
export function findModelsDir(configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.env.BAIHUA_HOME) candidates.push(join(process.env.BAIHUA_HOME, "models"));
  candidates.push(join(homedir(), ".baihua", "models"), join(homedir(), ".openclaw", "models"));
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 收集一个模型目录里的 OpenVINO IR 文件名（只看本层与直接子目录）。
 *
 * OVMS 的目录布局是 `<模型>/1/openvino_*.xml`（版本子目录），也有单层导出，
 * 所以只查顶层会漏掉绝大多数模型 —— 曾经因此把 Qwen3-4B 判成 other。
 *
 * @param {string} dir - 模型目录。
 * @returns {Set<string>} IR 文件名集合。
 */
function collectIrFiles(dir) {
  const names = new Set();
  const scan = (current) => {
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        if (/^openvino_.*\.xml$/.test(entry.name)) names.add(entry.name);
      }
    } catch {
      /* 读不到就当没有 */
    }
  };
  scan(dir);
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) scan(join(dir, entry.name));
    }
  } catch {
    /* 同上 */
  }
  return names;
}

/**
 * 从目录名或 openvino_config.json 里读量化格式。
 * @param {string} name - 模型目录名。
 * @param {unknown} configured - openvino_config.json 的 weight_format / dtype。
 * @returns {string|null} int4 / int8 / fp16 等。
 */
function detectDtype(name, configured) {
  if (typeof configured === "string" && configured) return configured;
  const match = /(int4|int8|fp16|fp32|bf16|u4|u8)/i.exec(name);
  return match ? match[1].toLowerCase() : null;
}

/**
 * 判断模型类型。优先级：VL 产物 > 目录名里的 embedding 线索 > 语言模型产物 >
 * config.json 的 architectures > 文本 tokenizer IR；都不匹配才算 other（如 TTS）。
 * @param {{ir: Set<string>, arch: unknown, name: string}} entry - 扫描中间态。
 * @returns {'VL'|'LLM'|'embedding'|'other'} 类型。
 */
export function classifyModel(entry) {
  const ir = entry.ir ?? new Set();
  const hasAny = (pattern) => [...ir].some((file) => pattern.test(file));
  const archs = Array.isArray(entry.arch) ? entry.arch.join(" ") : String(entry.arch ?? "");

  if (hasAny(/^openvino_vision_embeddings/)) return "VL";
  if (/embedding|bge|e5-|gte-|jina/i.test(entry.name)) return "embedding";
  if (ir.has("openvino_language_model.xml")) return "LLM";
  if (/ForCausalLM|LMHead|ForConditionalGeneration/.test(archs)) return "LLM";
  if (/BertModel|ForMaskedLM/.test(archs)) return "embedding";
  // 单文件 IR 既能是聊天模型也能是 TTS：带文本 tokenizer IR 才按 LLM 算。
  if (ir.has("openvino_model.xml") && (ir.has("openvino_tokenizer.xml") || ir.has("openvino_detokenizer.xml"))) {
    return "LLM";
  }
  if (ir.size === 0 && /embedding/i.test(entry.name)) return "embedding";
  return "other";
}

/**
 * 统计目录体积（GB，两位小数）。
 * @param {string} dir - 目录。
 * @returns {number|null} GB 数，读取失败返回 null。
 */
function dirSizeGb(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else total += statSync(full).size;
      } catch {
        /* 权限/竞态：跳过该文件 */
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return Math.round((total / 1024 ** 3) * 100) / 100;
}

/**
 * 扫描模型目录。
 * @param {string|null} modelsDir - 模型目录。
 * @returns {Array<{name: string, hasLang: boolean, hasVision: boolean, hasEmbed: boolean, dtype: string|null, arch: unknown, sizeGb: number|null, type: string}>} 模型条目。
 */
export function scanModels(modelsDir) {
  if (!modelsDir || !existsSync(modelsDir)) return [];
  const out = [];
  for (const name of readdirSync(modelsDir).sort()) {
    const dir = join(modelsDir, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const ir = collectIrFiles(dir);
    const entry = {
      name,
      ir,
      hasLang: ir.has("openvino_language_model.xml"),
      hasVision: [...ir].some((file) => /^openvino_vision_embeddings/.test(file)),
      hasTokenizer: ir.has("openvino_tokenizer.xml") || ir.has("openvino_detokenizer.xml"),
      hasSingleFileIr: ir.has("openvino_model.xml"),
      dtype: null,
      arch: null,
      sizeGb: dirSizeGb(dir),
    };
    for (const [file, field] of [["config.json", "arch"], ["openvino_config.json", "dtype"]]) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (field === "arch") entry.arch = parsed.architectures ?? parsed.model_type ?? null;
        else entry.dtype = parsed.weight_format ?? parsed.dtype ?? null;
      } catch {
        /* 损坏的 json 不影响整体扫描 */
      }
    }
    entry.dtype = detectDtype(name, entry.dtype);
    entry.type = classifyModel(entry);
    delete entry.ir;
    out.push(entry);
  }
  return out;
}

/**
 * 查询 OVMS 注册情况。
 *
 * `/v1/models` 给出已注册 id；`/v1/config` 给出每个 id 的 state（已注册=可用，OVMS 懒加载，
 * 首次请求才编译——这是 biancang issue 沉淀下来的语义）。两者任一失败都如实回报，不抛。
 *
 * @param {string} [baseUrl] - OVMS 基地址。
 * @param {AbortSignal} [signal] - 取消信号。
 * @param {number} [timeoutMs] - 单次请求超时。
 * @returns {Promise<{ids: string[], states: Record<string, string|null>, error?: string}>} 注册结果。
 */
export async function fetchOvms(baseUrl, signal, timeoutMs = 3000) {
  const base = (baseUrl || DEFAULT_OVMS_URL).replace(/\/+$/, "");
  /**
   * @param {string} pathName - `/v1/models` 或 `/v1/config`。
   * @returns {Promise<unknown>} 解析后的 JSON。
   */
  const request = async (pathName) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener?.("abort", forwardAbort, { once: true });
    try {
      const response = await fetch(base + pathName, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", forwardAbort);
    }
  };

  try {
    const [models, config] = await Promise.all([
      request("/v1/models"),
      request("/v1/config").catch(() => null),
    ]);
    const ids = (models?.data ?? []).map((item) => item?.id).filter((id) => typeof id === "string");
    /** @type {Record<string, string|null>} */
    const states = {};
    if (config && typeof config === "object") {
      for (const [id, value] of Object.entries(config)) {
        const status = value?.model_version_status?.[0];
        states[id] = typeof status?.state === "string" ? status.state : null;
      }
    }
    return { ids, states };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "超时" : "不可达";
    return { ids: [], states: {}, error: `${reason}: ${error?.message ?? String(error)}` };
  }
}
