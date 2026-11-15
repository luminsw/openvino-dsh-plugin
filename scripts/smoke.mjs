/**
 * 独立冒烟测试：不依赖 cordis 上下文，直接跑探测并打印环境/模型报告。
 * 用法：node scripts/smoke.mjs
 *
 * 分两段：
 *  - 原生段（OVMS 注册 + 模型目录）：纯 Node，**无需 python**，一定跑。
 *  - python 段（设备/版本）：本机有 python + openvino 才有内容，没有就如实跳过。
 */
import { findPython, runProbe } from "../src/probe.js";
import { fetchOvms, findModelsDir, scanModels } from "../src/native.js";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// 最小 shell 桩：实现当前契约的 resolve()+execute()（旧版是 run()，已不存在）
const shell = {
  resolve: (req) => ({ timeoutMs: 30000, stdoutMaxBytes: 4_000_000, ...req }),
  async execute(spec) {
    // 命令形如 `python <path>`；用 JSON.parse 恢复带引号的参数
    const args = [];
    for (const token of spec.command.split(" ")) {
      if (!token) continue;
      if (token.startsWith('"') && token.endsWith('"')) args.push(JSON.parse(token));
      else args.push(token);
    }
    const [cmd, ...rest] = args;
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    try {
      const result = await run(cmd, rest, {
        timeout: spec.timeoutMs,
        maxBuffer: spec.stdoutMaxBytes || 4_000_000,
        encoding: "utf8",
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      exitCode = error.code ?? 1;
      stderr = error.stderr ?? String(error);
    }
    return { result: async () => ({ exitCode, stdout: { text: stdout }, stderr: { text: stderr } }) };
  },
};

console.log("== 原生段（无需 python）==");
const modelsDir = findModelsDir("");
const models = scanModels(modelsDir);
const ovms = await fetchOvms();
console.log("modelsDir:", modelsDir ?? "未找到");
console.log("ovms:", ovms.error ? `ERR ${ovms.error}` : ovms.ids.join(", ") || "无");
for (const m of models) {
  const state = m.dtype ? m.dtype : "dtype?";
  console.log(`  [${m.type}] ${m.name} · ${state} · ${m.sizeGb ?? "?"}GB`);
}

console.log("\n== python 段（设备/版本，可选）==");
const probe = await findPython(shell, undefined, {});
console.log("python:", probe.python ?? `未找到（试过 ${probe.tried.join(" / ")}）`);
if (probe.errors.length) console.log("原因:", probe.errors.join(" | "));
if (!probe.python) {
  console.log("SKIP: 没有可用 python，设备与版本信息跳过");
  console.log("\n== SMOKE OK（原生段通过） ==");
  process.exit(0);
}

const report = await runProbe(shell, probe.python);
console.log("platform:", JSON.stringify(report.platform));
console.log("openvino:", JSON.stringify(report.openvino));
console.log("devices:", (report.devices || []).map((d) => `${d.id}=${d.fullName}`).join(", ") || "无");

console.log("\n== SMOKE OK ==");
