/**
 * 独立冒烟测试：不依赖 cordis 上下文，直接跑探测脚本并打印环境/模型报告。
 * 用法：node scripts/smoke.mjs
 *
 * 需要本机有 python + openvino；OVMS(:8000) 可选项。
 * 说明：smoke 桩用临时 .py 文件方式喂脚本（execFile 的 stdin 管道在 Windows 上
 * 对 `py -3.12 -` 不可靠）；插件运行时的 DSH shell 服务 stdin 路径不受影响。
 */
import { findPython, runProbe } from "../src/probe.js";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

// 最小 shell 桩：把 stdin 脚本写成临时文件再执行（Windows 下 stdin 管道不可靠）
const shell = {
  resolve: (req) => req,
  async run(spec) {
    const parts = spec.command.split(" ");
    const [cmd, ...rest] = parts;
    let args = rest.length ? rest : [];
    const opts = { timeout: spec.timeoutMs, maxBuffer: spec.stdoutMaxBytes || 4_000_000, encoding: "utf8" };
    if (spec.stdin) {
      const dir = mkdtempSync(join(tmpdir(), "dsh-ov-smoke-"));
      const file = join(dir, "probe.py");
      writeFileSync(file, spec.stdin, "utf8");
      args = [...args.slice(0, -1), file]; // 替换末尾的 `-` 为临时文件路径
      try {
        const { stdout, stderr } = await run(cmd, args, opts);
        return { exitCode: 0, stdout: { text: stdout }, stderr: { text: stderr } };
      } catch (e) {
        return { exitCode: e.code ?? 1, stdout: { text: "" }, stderr: { text: e.stderr ?? String(e) } };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    try {
      const { stdout, stderr } = await run(cmd, args, opts);
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
