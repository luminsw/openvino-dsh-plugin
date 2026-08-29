/**
 * 独立冒烟测试：不依赖 cordis 上下文，直接跑探测脚本并打印环境/模型报告。
 * 用法：node scripts/smoke.mjs
 *
 * 需要本机有 python + openvino；OVMS(:8000) 可选项。
 */
import { findPython, runProbe } from "../src/probe.js";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// 最小 shell 桩：直接 execFile 执行命令（无 stdin，因为 probe.py 走文件方式）
const shell = {
  resolve: (req) => req,
  async run(spec) {
    // 命令形如 "py -3.12 <path>" 或 "py -3.12 -c \"...\""；用 JSON.parse 恢复引号参数
    const args = [];
    for (const token of spec.command.split(" ")) {
      if (!token) continue;
      if (token.startsWith('"') && token.endsWith('"')) args.push(JSON.parse(token));
      else args.push(token);
    }
    const [cmd, ...rest] = args;
    try {
      const { stdout, stderr } = await run(cmd, rest, {
        timeout: spec.timeoutMs,
        maxBuffer: spec.stdoutMaxBytes || 4_000_000,
        encoding: "utf8",
      });
      return { exitCode: 0, stdout: { text: stdout }, stderr: { text: stderr } };
    } catch (e) {
      return { exitCode: e.code ?? 1, stdout: { text: "" }, stderr: { text: e.stderr ?? String(e) } };
    }
  },
};

console.log("== findPython ==");
const python = await findPython(shell);
console.log("python:", python);
if (!python) {
  console.log("SKIP: no python");
  process.exit(0);
}

console.log("== probe ==");
const report = await runProbe(shell, python);
console.log("platform:", JSON.stringify(report.platform));
console.log("openvino:", JSON.stringify(report.openvino));
console.log("devices:", report.devices.map((d) => `${d.id}=${d.fullName}`).join(", "));
console.log("ovms:", Array.isArray(report.ovms) ? report.ovms.join(", ") : JSON.stringify(report.ovms));
console.log("modelsDir:", report.modelsDir);
for (const m of report.models) {
  console.log(`  [${m.type}] ${m.name} · ${m.dtype || "dtype?"} · ${m.sizeGb ?? "?"}GB`);
}

console.log("== SMOKE OK ==");
