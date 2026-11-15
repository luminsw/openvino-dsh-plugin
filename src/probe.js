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
 * 通过 shell 执行（stdlib 回退路径，命令以字符串拼接，注意引号）。
 * @param {object} shell - ctx.shell 服务。
 * @param {{argv: string[], timeoutMs: number, stdoutMaxBytes: number, signal?: AbortSignal}} request - 请求。
 * @returns {Promise<{exitCode: number|null, stdout: {text: string}, stderr: {text: string}, timedOut: boolean}>} 结果。
 */
async function runViaShell(shell, request) {
  if (typeof shell?.execute !== "function") {
    throw new Error(
      "既没有 ctx.subprocess 也没有可用的 ctx.shell.execute()：无法执行外部命令（旧版 shell.run 已不存在）",
    );
  }
  const quote = (value) => (/^[A-Za-z0-9_\-.:\\/]+$/.test(value) ? value : `"${String(value).replaceAll('"', '\\"')}"`);
  const command = request.argv.map(quote).join(" ");
  const handle = await shell.execute(
    shell.resolve({ command, timeoutMs: request.timeoutMs, stdoutMaxBytes: request.stdoutMaxBytes, signal: request.signal }),
  );
  const result = await handle.result();
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut === true };
}

/**
 * 通过 ctx.subprocess 执行并收集输出。
 *
 * 为什么优先走这里：`ctx.shell` 的实现带沙箱，而 Windows ACL 沙箱要求「temp root 在 workspace 之外」。
 * 本机 workspace 是 `C:\Users\lumin`、TEMP 又在其中，于是所有 shell 调用被整体拒绝
 * （`Windows ACL temp root must be outside the workspace`）。这是宿主环境问题，插件改不了；
 * 而 openvino 的 bench/convert 本来就要读写模型目录（GB 级权重），只能在宿主权限下跑，
 * 所以用 DSH 自己的 subprocess seam：它不套沙箱，且收 argv 数组，没有引号解析问题。
 *
 * @param {object} subprocess - ctx.subprocess 服务。
 * @param {{argv: string[], cwd?: string, timeoutMs: number, stdoutMaxBytes: number, signal?: AbortSignal}} request - 请求。
 * @returns {Promise<{exitCode: number|null, stdout: {text: string}, stderr: {text: string}, timedOut: boolean}>} 结果。
 */
async function runViaSubprocess(subprocess, request) {
  const handle = subprocess.spawn({
    argv: request.argv,
    cwd: request.cwd ?? homedir(),
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: request.stdoutMaxBytes },
      stderr: { maxBytes: 200_000 },
    },
    graceMs: 5000,
    signal: request.signal,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    handle.terminate();
  }, request.timeoutMs);
  try {
    const outcome = await handle.done;
    const read = (reader) => (reader ? reader.readFrom(0).text : "");
    return {
      exitCode: outcome.exitCode,
      stdout: { text: read(handle.collected.stdout) },
      stderr: { text: read(handle.collected.stderr) },
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行外部命令：优先 ctx.subprocess，其次 ctx.shell。
 * @param {{shell?: object, subprocess?: object}} runtime - 可用的执行服务。
 * @param {{argv: string[], cwd?: string, timeoutMs?: number, stdoutMaxBytes?: number, signal?: AbortSignal}} request - 请求。
 * @returns {Promise<{exitCode: number|null, stdout: {text: string}, stderr: {text: string}, timedOut: boolean}>} 结果。
 */
export async function runCommand(runtime, request) {
  const spec = { timeoutMs: 30000, stdoutMaxBytes: 1_000_000, ...request };
  if (typeof runtime?.subprocess?.spawn === "function") return runViaSubprocess(runtime.subprocess, spec);
  return runViaShell(runtime?.shell, spec);
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
 * 候选（argv 前缀，按顺序验证）：配置的 pythonCmd → OPENVINO_PYTHON →
 * `ctx.subprocess.resolveExecutable` 解析出的路径 → 宿主 PATH 绝对路径 →
 * 常见安装位置 → `py -3.12` / `python` / `python3`。
 *
 * @param {{shell?: object, subprocess?: object}} runtime - 执行服务。
 * @param {AbortSignal} [signal] - 取消信号。
 * @param {{pythonCmd?: string}} [config] - 插件配置。
 * @returns {Promise<{python: string[]|null, pythonCommand: string|null, tried: string[], errors: string[]}>} 探测结果。
 */
export async function findPython(runtime, signal, config = {}) {
  /** @type {string[][]} */
  const candidates = [];
  const seen = new Set();
  const push = (argv) => {
    const list = argv.map((value) => String(value ?? "").trim()).filter(Boolean);
    if (!list.length) return;
    const key = list.join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(list);
  };

  if (config.pythonCmd) push(String(config.pythonCmd).split(/\s+/));
  if (process.env.OPENVINO_PYTHON) push(String(process.env.OPENVINO_PYTHON).split(/\s+/));

  // subprocess provider 有自己的受信 PATH，先让它解析（最接近"这个执行世界里真实的 python"）
  if (typeof runtime?.subprocess?.resolveExecutable === "function") {
    for (const name of ["python", "python3"]) {
      try {
        const resolved = await runtime.subprocess.resolveExecutable(name, undefined, signal);
        if (resolved) push([resolved]);
      } catch {
        /* 解析不到就继续 */
      }
    }
  }
  // DSH shell 的 PATH 可能与宿主进程不同：宿主 PATH 上解析到的绝对路径更可靠
  for (const hit of resolveOnHostPath("python")) push([hit]);
  for (const hit of resolveWellKnownPythons()) push([hit]);
  push(["py", "-3.12"]);
  push(["python"]);
  push(["python3"]);

  /** @type {string[]} */
  const tried = [];
  /** 去重后的失败原因（多个候选常常因为同一个环境原因一起失败，不必重复多遍）。 */
  const reasons = new Set();
  const note = (value) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const short = text.includes("sandbox")
      ? `sandbox: ${text.split("Runner failure:")[0]}`
      : text;
    reasons.add(short.length > 240 ? `${short.slice(0, 240)}…` : short);
  };
  for (const argv of candidates) {
    const label = argv.join(" ");
    tried.push(label);
    try {
      const result = await runCommand(runtime, { argv: [...argv, "--version"], timeoutMs: 8000, signal });
      if (result.exitCode === 0) {
        return { python: argv, pythonCommand: label, tried, errors: [...reasons] };
      }
      note(`${label}: exit ${result.exitCode} ${result.stderr.text.trim()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // shell/registry 本身故障不能被当成"没有解释器"
      if (/is not a function|缺少 execute|既没有/.test(message)) throw new Error(`执行服务不可用：${message}`);
      note(`${label}: ${message}`);
    }
  }
  return { python: null, pythonCommand: null, tried, errors: [...reasons] };
}

/**
 * 把 argv 变成可直接粘贴到终端的命令字符串（仅用于展示）。
 * @param {string[]} argv - 参数数组。
 * @returns {string} 展示用命令。
 */
export function formatCommand(argv) {
  return argv
    .map((value) => (/^[A-Za-z0-9_\-.:\\/]+$/.test(value) ? value : `"${String(value).replaceAll('"', '\\"')}"`))
    .join(" ");
}

/**
 * 执行 probe.py 并解析 JSON 报告（设备与版本信息，只有 python 能给）。
 * @param {{shell?: object, subprocess?: object}} runtime - 执行服务。
 * @param {string[]} python - 解释器 argv 前缀。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<object>} 探测报告。
 */
export async function runProbe(runtime, python, signal) {
  const result = await runCommand(runtime, {
    argv: [...python, PROBE_PATH],
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
 * argv 数组直传，`-c` 里的代码不需要再套引号。
 * @param {{shell?: object, subprocess?: object}} runtime - 执行服务。
 * @param {string[]} python - 解释器 argv 前缀。
 * @param {string} moduleName - 模块名。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<boolean>} 是否可导入。
 */
export async function hasModule(runtime, python, moduleName, signal) {
  try {
    const result = await runCommand(runtime, {
      argv: [...python, "-c", `import importlib.util;print(bool(importlib.util.find_spec('${moduleName}')))`],
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
