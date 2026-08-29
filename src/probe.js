/**
 * probe.js — OpenVINO 探测核心。
 *
 * 职责：
 *  - 维护探测脚本路径 `src/probe.py`（设备/版本/OVMS/模型目录一次输出 JSON）；
 *    ⚠️ 必须用「文件方式」执行（`python <probe.py>`），不要用 stdin（`python -`）——
 *    实测 DSH shell 服务下 stdin 模式退出码异常（exit 1 且 stderr 空），文件方式稳定 exit 0。
 *  - findPython：探测本机可用的 python 命令（py -3.12 > python > python3）；
 *  - runProbe：执行 probe.py 并解析 JSON 报告；
 *  - fileExists：跨 shell 方言安全的文件存在性探测（python -c 内联）；
 *  - DIR_TO_OMS / OMS_TO_DIR：模型目录名 ↔ OVMS servable id 映射（对齐百花
 *    Baihua.AI.Provider.OpenVino/OmsModelMap.cs，新增模型时两个方向都要补）。
 *
 * 全部探测静默容错：任何服务不可达 / 文件不可读都不影响工具执行，结果如实反映。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  "BianCang-Qwen2.5-7B-Instruct": "biancang",
  "bge-small-zh-v1.5": "bge-small-zh",
};

/** OMS id → 目录名（反向映射）。 */
export const OMS_TO_DIR = Object.fromEntries(Object.entries(DIR_TO_OMS).map(([k, v]) => [v, k]));

/**
 * 探测本机可用的 python 命令。
 * @param {object} shell ctx.shell 服务
 * @param {AbortSignal} [signal]
 * @returns {Promise<string|null>}
 */
export async function findPython(shell, signal) {
  for (const c of ["py -3.12", "python", "python3"]) {
    try {
      const r = await shell.run(shell.resolve({ command: `${c} --version`, timeoutMs: 8000, signal }));
      if (r.exitCode === 0) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * 执行探测脚本（文件方式）并解析 JSON 报告。
 * @param {object} shell
 * @param {string} python
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
export async function runProbe(shell, python, signal) {
  const r = await shell.run(shell.resolve({
    command: `${python} ${JSON.stringify(PROBE_PATH)}`,
    timeoutMs: 60000,
    stdoutMaxBytes: 2000000,
    signal,
  }));
  if (r.exitCode !== 0) throw new Error(`探测失败: ${r.stderr.text || `exit ${r.exitCode}`}`);
  return JSON.parse(r.stdout.text);
}

/** 跨 shell 方言安全的文件存在探测（python -c 内联，Windows/Linux 均可用）。 */
export async function fileExists(shell, python, path, signal) {
  const r = await shell.run(shell.resolve({
    command: `${python} -c "import os,sys;print(os.path.exists(sys.argv[1]))" ${JSON.stringify(path)}`,
    timeoutMs: 8000,
    signal,
  }));
  return r.exitCode === 0 && r.stdout.text.trim().toLowerCase().startsWith("true");
}
