/**
 * probe.js — python 层：只服务 openvino_bench / openvino_convert，以及 env_diag 的可选增强。
 *
 * 状态类查询（OVMS 注册 / 模型目录）已移到 native.js，不再经过 python。
 *
 * ⚠️ 两个曾经踩过的坑，别再犯：
 *  1. `ctx.shell` 只提供 `resolve()` + `execute()`，**没有 `run()`**。调 `shell.run` 会抛
 *     `TypeError: shell.run is not a function`；早期 findPython 把它吞进 try/catch，
 *     于是"API 不兼容"被伪装成"未找到 python"。现在一律走 runShell 并如实抛出。
 *  2. 探测脚本必须用「文件方式」执行（`python <probe.py>`），不要 stdin（`python -`）：
 *     DSH shell 服务下 stdin 模式退出码异常（exit 1 且 stderr 空），文件方式稳定 exit 0。
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 探测脚本绝对路径（本文件同目录下的 probe.py）。 */
export const PROBE_PATH = join(dirname(fileURLToPath(import.meta.url)), "probe.py");

/** 模型目录名 ↔ OVMS servable id（对齐 Baihua.AI.Provider.OpenVino/OmsModelMap.cs）。 */
export const DIR_TO_OMS = {
  "Qwen2.5-VL-7B-Instruct-int4-ov": "qwen2.5-vl-7b",
  "Qwen2.5-VL-3B-Instruct-int4-ov": "qwen2.5-vl-3b",
  "Qwen2.5-7B-Instruct-int4-ov": "qwen2.5",
  "Qwen2.5-14B-Instruct-INT4-OV": "qwen2.5-14b",
  "Qwen2.5-Coder-7B-Instruct-int4-ov": "qwen2.5-coder-7b",
  "Qwen3.5-9B-int8-ov": "qwen3.5-9b",
  "Qwen3-4B-int4-ov": "qwen3-4b",
  "Qwen3-Embedding-0.6B-int8-ov": "qwen3-embedding-0.6b",
  "BianCang-Qwen2.5-7B-Instruct": "biancang",
  "bge-small-zh-v1.5": "bge-small-zh",
};

/** OMS id → 目录名（反向映射）。 */
export const OMS_TO_DIR = Object.fromEntries(Object.entries(DIR_TO_OMS).map(([k, v]) => [v, k]));

/**
 * 通过 `ctx.shell` 执行命令并等待结果。
 * @param {object} shell - ctx.shell 服务。
 * @param {{command: string, timeoutMs?: number, stdoutMaxBytes?: number, workdir?: string, signal?: AbortSignal}} request - 执行请求。
 * @returns {Promise<{exitCode: number|null, stdout: {text: string}, stderr: {text: string}}>} 运行结果。
 */
export async function runShell(shell, request) {
  if (typeof shell?.execute !== "function") {
    throw new Error(
      "ctx.shell 缺少 execute()：当前 DSH 的 shell 服务是 resolve()+execute()，本插件不再使用旧的 shell.run()",
    );
  }
  const handle = await shell.execute(shell.resolve({ timeoutMs: 30000, ...request }));
  return handle.result();
}

/**
 * 在宿主进程的 PATH 里找可执行文件的绝对路径。
 *
 * 为什么不能只靠 shell：`ctx.shell` 的执行环境 PATH 可能与宿主进程不同——实测本机
 * `python` 在宿主 PATH 上、DSH shell 里却解析不到，于是 `python --version` 失败，
 * 三个字面候选全判死。Node 侧先解析出绝对路径，再交给 shell 验证，就绕开了这层差异。
 *
 * @param {string} exe - 可执行文件名，如 `python`。
 * @returns {string[]} 命中的绝对路径。
 */
function resolveOnHostPath(exe) {
  const hits = [];
  const extensions = [".exe", ".cmd", ".bat", ""];
  for (const dir of String(process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, exe + extension);
      if (existsSync(candidate) && !hits.includes(candidate)) hits.push(candidate);
    }
  }
  return hits;
}

/**
 * 常见安装位置里的 python（PATH 上找不到时的兜底）。
 * @returns {string[]} 存在的绝对路径。
 */
function resolveWellKnownPythons() {
  const roots = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Python"),
    join(process.env.ProgramFiles ?? "", "Python"),
    "C:\\Python312",
    "C:\\Python311",
    join(homedir(), "ovms", "python"),
    join(process.env.LOCALAPPDATA ?? "", "ovms", "python"),
  ].filter((root) => root && existsSync(root));
  const hits = [];
  for (const root of roots) {
    const direct = join(root, "python.exe");
    if (existsSync(direct)) hits.push(direct);
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const nested = join(root, entry.name, "python.exe");
        if (existsSync(nested)) hits.push(nested);
      }
    } catch {
      /* 读不到就跳过 */
    }
  }
  return hits;
}

/**
 * 探测可用的 python 解释器。
 *
 * 顺序：配置的 pythonCmd → OPENVINO_PYTHON 环境变量 → 宿主 PATH 上的绝对路径 →
 * 常见安装位置 → `py -0p` 列出的解释器 → `where python` 命中路径 → 裸 `py -3.12` /
 * `python` / `python3`。逐个用 `--version` 验证，任何一条能跑就用它。
 *
 * @param {object} shell - ctx.shell 服务。
 * @param {AbortSignal} [signal] - 取消信号。
 * @param {{pythonCmd?: string}} [config] - 插件配置。
 * @returns {Promise<{python: string|null, tried: string[], errors: string[]}>} 探测结果；不抛异常，但会保留失败原因。
 */
export async function findPython(shell, signal, config = {}) {
  /** @type {string[]} */
  const candidates = [];
  const push = (value) => {
    const trimmed = String(value ?? "").trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  push(config.pythonCmd);
  push(process.env.OPENVINO_PYTHON);
  for (const hit of resolveOnHostPath("python")) push(hit);
  for (const hit of resolveWellKnownPythons()) push(hit);

  // 已安装解释器清单：py -0p 输出形如 ` -V:3.12 *        C:\...\python.exe`
  try {
    const listed = await runShell(shell, { command: "py -0p", timeoutMs: 8000, signal });
    if (listed.exitCode === 0) {
      for (const line of listed.stdout.text.split(/\r?\n/)) {
        const match = /([A-Za-z]:[\\/][^"\r\n]*python\.exe)/i.exec(line);
        if (match) push(match[1]);
      }
    }
  } catch {
    /* 没有 py 启动器：继续用其它来源 */
  }

  // PATH 里的 python / python3 完整路径（能覆盖 OVMS 自带的那份 python）
  for (const name of ["python", "python3"]) {
    try {
      const found = await runShell(shell, { command: `where ${name}`, timeoutMs: 8000, signal });
      if (found.exitCode === 0) {
        for (const line of found.stdout.text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed && /python(3)?\.exe$/i.test(trimmed)) push(trimmed);
        }
      }
    } catch {
      /* where 不可用：继续 */
    }
  }

  push("py -3.12");
  push("python");
  push("python3");

  /** @type {string[]} */
  const tried = [];
  /** 去重后的失败原因（7 个候选常常因为同一个环境原因一起失败，不必重复 7 遍）。 */
  const reasons = new Set();
  const note = (value) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text) reasons.add(text.length > 240 ? `${text.slice(0, 240)}…` : text);
  };
  for (const candidate of candidates) {
    tried.push(candidate);
    try {
      const result = await runShell(shell, { command: `${candidate} --version`, timeoutMs: 8000, signal });
      if (result.exitCode === 0) return { python: candidate, tried, errors: [...reasons] };
      note(`${candidate}: exit ${result.exitCode} ${result.stderr.text.trim()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // shell API 本身的故障不能被当成"没有解释器"
      if (/is not a function|缺少 execute/.test(message)) throw new Error(`shell 服务不兼容：${message}`);
      // 沙箱拒绝执行时，7 个候选的原因完全相同：只留一条。
      note(message.includes("sandbox") ? `sandbox: ${message.split("Runner failure:")[0]}` : `${candidate}: ${message}`);
    }
  }
  return { python: null, tried, errors: [...reasons] };
}

/**
 * 执行 probe.py 并解析 JSON 报告（设备与版本信息，只有 python 能给）。
 * @param {object} shell - ctx.shell 服务。
 * @param {string} python - 解释器命令。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<object>} 探测报告。
 */
export async function runProbe(shell, python, signal) {
  const result = await runShell(shell, {
    command: `${python} ${JSON.stringify(PROBE_PATH)}`,
    timeoutMs: 60000,
    stdoutMaxBytes: 2000000,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(`探测失败: ${result.stderr.text || `exit ${result.exitCode}`}`);
  }
  return JSON.parse(result.stdout.text);
}

/**
 * python 模块可用性检查（bench 要 openvino_genai，convert 要 optimum）。
 * @param {object} shell - ctx.shell 服务。
 * @param {string} python - 解释器命令。
 * @param {string} moduleName - 模块名。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<boolean>} 是否可导入。
 */
export async function hasModule(shell, python, moduleName, signal) {
  try {
    const result = await runShell(shell, {
      command: `${python} -c "import importlib.util;print(bool(importlib.util.find_spec('${moduleName}')))"`,
      timeoutMs: 20000,
      signal,
    });
    return result.exitCode === 0 && result.stdout.text.trim().includes("True");
  } catch {
    return false;
  }
}

/**
 * 文件存在性（纯 Node，不再借 python）。
 * @param {string} path - 绝对路径。
 * @returns {boolean} 是否存在。
 */
export function fileExists(path) {
  return existsSync(path);
}
