/**
 * openvino-dsh-plugin — 把与 Intel GPU + OpenVINO 打交道的积累沉淀为 DSH 工具。
 *
 * 功能（全部 Host 侧、只读探测/生成命令/执行本机 python，无 UI）：
 *  1. openvino_env_diag   —— 环境一键体检：CPU/GPU/NPU 设备与型号、openvino/genai 版本、
 *                            OVMS(:8000) 注册模型、模型目录，并给出修复建议。
 *  2. openvino_models_scan—— 模型目录扫描：类型(LLM/VL/embedding)/精度/大小/OVMS 注册。
 *  3. openvino_status     —— 统一状态判定：OVMS 注册 ↔ 目录 ↔ OmsModelMap（注册即运行中，
 *                            沉淀 biancang issue 的懒加载语义）。
 *  4. openvino_bench      —— 基准测试：包装 scripts/openvino_benchmark.py（TTFT/吞吐）。
 *  5. openvino_convert    —— HF→OpenVINO INT4 转换：固化正确姿势（optimum-cli
 *                            --weight-format int4 = NNCF，纠正 load_in_4bit 误用）+ 产物校验。
 *
 * 安装：本包是标准 DSH 组合包（package.json 声明 dsh.bundle），执行
 *   dsh plugin --profile web add github:luminsw/openvino-dsh-plugin
 * 后由 profile 组合自动应用 cordis.patch.yml 层；配置项按 id 在 profile 的
 * cordis.patch.yml 里覆盖（如 - id: dsh-openvino / config: {...}）。
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DIR_TO_OMS, OMS_TO_DIR, findPython, runProbe, fileExists } from "./probe.js";

export const name = "dsh-openvino";

export const inject = ["tools", "webServer"];

export const Config = z.object({
  /** 模型目录（默认自动探测 BAIHUA_HOME/models，其次 ~/.baihua/models、~/.openclaw/models）。 */
  modelsDir: z.string().default(""),
  /** OVMS 基地址（状态/体检探测用）。 */
  ovmsUrl: z.string().default("http://127.0.0.1:8000"),
  /** python 命令（默认自动探测 py -3.12 > python > python3）。 */
  pythonCmd: z.string().default(""),
  /** openvino_benchmark.py 路径（默认自动探测 ~/src/baihua/scripts/ 与 BAIHUA_HOME）。 */
  benchScriptPath: z.string().default(""),
  /** 默认导出任务（openvino_convert）。 */
  convertTask: z.string().default("text-generation-with-past"),
  /** 状态端点鉴权 token（留空 = 回环免鉴权）。 */
  token: z.string().role("secret").default(""),
});

export function apply(ctx, config) {
  // 注意：不在此处提前 return——即使 apply 时 shell 服务尚未就绪，也要先注册工具，
  // shell 在 execute 时经 getShell() 获取（执行时服务必然就绪）。早期 return 会静默
  // 丢失全部工具注册（本插件曾因此整包不加载）。
  const getShell = () => ctx.get("shell");

  /** 输出 schema 帮助函数：嵌套 object 需显式 additionalProperties，数组需 items。 */
  const obj = (props, additionalProperties = true) => ({ type: "object", properties: props, additionalProperties });
  const arr = (items) => ({ type: "array", items });
  const str = () => ({ type: "string" });
  const bool = () => ({ type: "boolean" });
  const int = () => ({ type: "integer" });

  const tools = [
    defineTool({
      name: "openvino_env_diag",
      description:
        "Intel GPU / OpenVINO 环境一键体检（只读）：探测 CPU/GPU/NPU 设备与型号、openvino/openvino_genai 版本、OVMS(:8000) 运行状态与注册模型、BAIHUA_HOME 模型目录，并给出修复建议（OVMS 未运行→如何启动、模型未注册 OVMS→如何 configure、NPU 不可用→驱动提示）。新机器接入百花本地 AI 栈先跑这个。",
      parameters: {},
      output: {
        schema: obj({ summary: str(), report: obj({}, true), fixes: arr(str()) }),
        render: (_args, v) => [{ type: "text", text: v.summary }],
      },
      timeoutMs: 90000,
      async execute(args, exec) {
        const shell = getShell();
        if (!shell) throw new Error("shell 服务不可用，无法执行 OpenVINO 工具");
        const python = config.pythonCmd || (await findPython(shell, exec.signal));
        if (!python) throw new Error("未找到 python（试过 py -3.12 / python / python3），无法体检 OpenVINO 环境");
        const report = await runProbe(shell, python, exec.signal);
        const fixes = [];
        if (report.openvino && report.openvino.error) {
          fixes.push(`openvino 无法导入: ${report.openvino.error}（需 pip install openvino openvino-genai）`);
        }
        if (report.devices && !report.devices.length) fixes.push("OpenVINO 未枚举到任何设备，检查 openvino 安装");
        const npu = (report.devices || []).some((d) => d.id === "NPU");
        if (!npu && (report.devices || []).length) {
          fixes.push("未检测到 NPU：Intel AI Boost 需要 NPU 驱动（Intel NPU Driver / IPU6）与最新 openvino，驱动缺失时设备不可见");
        }
        const oms = report.ovms;
        if (Array.isArray(oms) && !oms.length) {
          fixes.push(`OVMS(:8000) 在跑但未注册任何模型：检查 ${report.modelsDir || "BAIHUA_HOME/models"}/config.json`);
        }
        if (oms && oms.error) {
          fixes.push(
            `OVMS(:8000) 未运行/不可达 (${oms.error})：Windows 用管理员运行 scripts/install-openvino-ovms-service.ps1，Linux 起 openvino pod；模型已下载但未注册时先 ovms --configure`,
          );
        }
        if (Array.isArray(oms) && report.models) {
          const registered = new Set(oms);
          const missing = report.models.filter((m) => {
            const oid = DIR_TO_OMS[m.name];
            return oid && !registered.has(oid);
          });
          if (missing.length) {
            fixes.push(
              "以下模型已下载但未注册 OVMS：" +
                missing.map((m) => `${m.name}→${DIR_TO_OMS[m.name] || "?"}`).join("、") +
                "（运行 ovms --configure --model_path <dir> --task text_generation --target_device GPU）",
            );
          }
        }
        if (!fixes.length) fixes.push("环境健康：无需修复");
        const devLine = (report.devices || []).map((d) => `${d.id}=${d.fullName || "?"}`).join(" | ");
        const omsLine = Array.isArray(oms) ? oms.join(", ") : String(oms.error || "");
        const summary =
          `设备: ${devLine || "无"}\n` +
          `openvino: ${report.openvino?.version || "?"} / genai: ${report.openvino?.genai || "?"}\n` +
          `OVMS 注册模型: ${omsLine || "无"}\n` +
          `模型目录: ${report.modelsDir || "未找到"}（${(report.models || []).length} 个）\n` +
          `建议: ${fixes.join("；")}`;
        return { summary, report, fixes };
      },
    }),

    defineTool({
      name: "openvino_models_scan",
      description:
        '扫描本机 OpenVINO 模型目录（默认 BAIHUA_HOME/models），列出每个模型的名称/类型(LLM/VL/embedding/other)/精度(dtype)/架构/大小/是否已注册 OVMS，回答"我有哪些本地模型、什么精度、能不能跑"。可传 modelsDir 覆盖目录。',
      parameters: {
        modelsDir: { type: "string", description: "模型目录（默认取 BAIHUA_HOME/models，其次 ~/.baihua/models、~/.openclaw/models）" },
      },
      output: {
        schema: obj({ models: arr(obj({}, true)), modelsDir: str() }),
        render: (_args, v) => [
          {
            type: "text",
            text:
              (v.models || [])
                .map(
                  (m) =>
                    `[${m.type}] ${m.name} · ${m.dtype || "dtype?"} · ${m.sizeGb ?? "?"}GB · OVMS:${m.registered ? "✓" : "✗"} · arch=${JSON.stringify(m.arch ?? null)}`,
                )
                .join("\n") || "无模型",
          },
        ],
      },
      timeoutMs: 90000,
      async execute(args, exec) {
        const shell = getShell();
        if (!shell) throw new Error("shell 服务不可用，无法执行 OpenVINO 工具");
        const python = config.pythonCmd || (await findPython(shell, exec.signal));
        if (!python) throw new Error("未找到 python，无法扫描模型目录");
        const report = await runProbe(shell, python, exec.signal);
        const modelsDir = args.modelsDir || config.modelsDir || report.modelsDir;
        const models = (report.models || []).map((m) => {
          const oid = DIR_TO_OMS[m.name];
          const registered = Array.isArray(report.ovms) && oid ? report.ovms.includes(oid) : null;
          return {
            name: m.name,
            type: m.type,
            dtype: m.dtype || null,
            arch: m.arch || null,
            sizeGb: m.sizeGb,
            omsId: oid || null,
            registered,
          };
        });
        return { models, modelsDir };
      },
    }),

    defineTool({
      name: "openvino_status",
      description:
        'OpenVINO 统一状态判定（沉淀 biancang issue 教训：OVMS 注册即视为"运行中"，因 OVMS 懒加载，注册=可用，首次请求才编译）。合并 OVMS /v1/models 注册 ↔ 本地目录 ↔ OmsModelMap 映射，输出每个模型的状态与不一致项（已注册但目录缺 / 已下载但未注册）。',
      parameters: {},
      output: {
        schema: obj({ rows: arr(obj({}, true)), anomalies: arr(str()) }),
        render: (_args, v) => [
          {
            type: "text",
            text:
              (v.rows || [])
                .map((r) => `${r.running ? "🟢" : r.installed ? "🟡" : "⚪"} ${r.name} [${r.type}] ${r.status}`)
                .join("\n") + `\n\n异常: ${v.anomalies?.length ? v.anomalies.join("；") : "无"}`,
          },
        ],
      },
      timeoutMs: 90000,
      async execute(args, exec) {
        const shell = getShell();
        if (!shell) throw new Error("shell 服务不可用，无法执行 OpenVINO 工具");
        const python = config.pythonCmd || (await findPython(shell, exec.signal));
        if (!python) throw new Error("未找到 python");
        const report = await runProbe(shell, python, exec.signal);
        const oms = Array.isArray(report.ovms) ? report.ovms : [];
        const omsSet = new Set(oms);
        const dirSet = new Set((report.models || []).map((m) => m.name));
        const rows = (report.models || []).map((m) => {
          const oid = DIR_TO_OMS[m.name];
          const registered = oid ? omsSet.has(oid) : false;
          return {
            name: m.name,
            type: m.type,
            omsId: oid || null,
            installed: true,
            registered,
            running: registered, // OVMS 注册即运行中（懒加载语义）
            status: registered ? "运行中（OVMS 已注册）" : "已下载未注册",
          };
        });
        const anomalies = [];
        for (const oid of oms) {
          const dir = OMS_TO_DIR[oid];
          if (dir && !dirSet.has(dir)) anomalies.push(`OVMS 注册了 ${oid} 但目录 ${dir} 缺失`);
          if (!dir) anomalies.push(`OVMS 注册了未知模型 id: ${oid}（不在 OmsModelMap）`);
        }
        if (!oms.length) anomalies.push("OVMS(:8000) 未注册任何模型（服务未运行或 config.json 为空）");
        return { rows, anomalies };
      },
    }),

    defineTool({
      name: "openvino_bench",
      description:
        "OpenVINO 本地推理基准测试：包装 scripts/openvino_benchmark.py，测指定模型在指定设备上的加载耗时/TTFT/解码吞吐/端到端吞吐，输出 JSON 报告。用于设备选型（CPU vs GPU vs NPU）与回归对比。注意：加载 7B 模型 + 多次生成较耗时（1-5 分钟）。",
      parameters: {
        models: { type: "array", items: { type: "string" }, description: "模型目录名（在模型目录下的子目录名，如 Qwen2.5-7B-Instruct-int4-ov）；默认第一个 LLM 模型" },
        devices: { type: "array", items: { type: "string" }, description: "设备列表，如 CPU / GPU / NPU；默认 CPU" },
        repeats: { type: "integer", description: "每个 prompt 重复次数（默认 1）" },
        scriptPath: { type: "string", description: "openvino_benchmark.py 路径（默认自动探测 ~/src/baihua/scripts/openvino_benchmark.py，其次 BAIHUA_HOME）" },
      },
      output: {
        schema: obj({ report: obj({}, true), summary: str() }),
        render: (_args, v) => [{ type: "text", text: v.summary }],
      },
      timeoutMs: 600000,
      async execute(args, exec) {
        const shell = getShell();
        if (!shell) throw new Error("shell 服务不可用，无法执行 OpenVINO 工具");
        const python = config.pythonCmd || (await findPython(shell, exec.signal));
        if (!python) throw new Error("未找到 python（基准需要 openvino_genai）");
        const probe = await runProbe(shell, python, exec.signal);
        const modelsDir = probe.modelsDir;
        if (!modelsDir) throw new Error("未找到模型目录（BAIHUA_HOME/models 等）");
        const llm = (probe.models || []).find((m) => m.type === "LLM");
        const models = Array.isArray(args.models) && args.models.length ? args.models : llm ? [llm.name] : [];
        if (!models.length) throw new Error("模型目录下没有 LLM 模型，请显式传 models");
        const devices = Array.isArray(args.devices) && args.devices.length ? args.devices : ["CPU"];
        let script = args.scriptPath || config.benchScriptPath;
        if (!script) {
          const cands = [
            "C:/Users/lumin/src/baihua/scripts/openvino_benchmark.py",
            "C:/Users/lumin/.baihua/scripts/openvino_benchmark.py",
          ];
          for (const c of cands) {
            if (await fileExists(shell, python, c, exec.signal)) {
              script = c;
              break;
            }
          }
        }
        if (!script) {
          throw new Error("未找到 openvino_benchmark.py，请传 scriptPath（仓库在 C:/Users/lumin/src/baihua/scripts/openvino_benchmark.py）");
        }
        const repeats = Math.max(1, Number(args.repeats) || 1);
        const cmd =
          `${python} ${JSON.stringify(script)} --models ${models.map((m) => JSON.stringify(m)).join(" ")} ` +
          `--devices ${devices.map((d) => JSON.stringify(d)).join(" ")} --repeats ${repeats}`;
        const r = await shell.run(shell.resolve({
          command: cmd,
          timeoutMs: 580000,
          stdoutMaxBytes: 4000000,
          signal: exec.signal,
        }));
        if (r.exitCode !== 0) throw new Error(`基准失败: ${r.stderr.text || r.stdout.text || `exit ${r.exitCode}`}`);
        const out = r.stdout.text;
        const m = /\{[\s\S]*\}/.exec(out);
        if (!m) throw new Error(`未解析到基准 JSON 输出：\n${out.slice(0, 3000)}`);
        const report = JSON.parse(m[0]);
        const lines = (report.runs || []).map(
          (run) =>
            `${run.model} @${run.device}: load=${(run.load_time_ms || 0).toFixed(0)}ms ttft=${(run.avg_ttft_ms || 0).toFixed(0)}ms tps=${(run.avg_tps || 0).toFixed(1)} e2e=${(run.avg_e2e_tps || 0).toFixed(1)}`,
        );
        return { report, summary: `模型: ${models.join(", ")} 设备: ${devices.join(", ")}\n${lines.join("\n")}` };
      },
    }),

    defineTool({
      name: "openvino_convert",
      description:
        "HF→OpenVINO INT4 转换（固化正确姿势）：生成并（可选）执行 optimum-cli 导出命令。关键纠正：load_in_4bit/load_in_8bit 是 transformers 的 bitsandbytes 参数，不是 optimum-intel 导出量化；正确做法是 optimum-cli export openvino --weight-format int4（内部 NNCF compress_weights）。dryRun=true 时只预检环境并输出命令；dryRun=false 时执行导出（长任务）并校验产物（openvino_model.xml / openvino_language_model.xml 存在、体积合理）。",
      parameters: {
        hfModelId: { type: "string", required: true, description: "HuggingFace 模型 id，如 Qwen/Qwen2.5-7B-Instruct" },
        outputDir: { type: "string", description: "输出目录（默认 BAIHUA_HOME/models/<name>-int4-ov）" },
        weightFormat: { type: "string", description: "量化格式（默认 int4；可选 int8/fp16）" },
        dryRun: { type: "boolean", description: "true=只输出命令+预检（默认）；false=实际执行导出（长任务）" },
        task: { type: "string", description: "导出任务（默认 text-generation-with-past）" },
      },
      output: {
        schema: obj({ check: obj({}, true), command: str(), outputDir: str(), executed: bool(), verified: obj({}, true), note: str() }),
        render: (_args, v) => [
          { type: "text", text: v.command + (v.executed ? `\n[已执行] 校验: ${JSON.stringify(v.verified)}` : "\n[dry-run] 未执行") },
        ],
      },
      timeoutMs: 600000,
      async execute(args, exec) {
        const shell = getShell();
        if (!shell) throw new Error("shell 服务不可用，无法执行 OpenVINO 工具");
        const python = config.pythonCmd || (await findPython(shell, exec.signal));
        if (!python) throw new Error("未找到 python");
        const checkCmd = `${python} -c "import importlib.util; print(bool(importlib.util.find_spec('optimum')))"`;
        let hasOptimum = false;
        try {
          const r = await shell.run(shell.resolve({ command: checkCmd, timeoutMs: 20000, signal: exec.signal }));
          hasOptimum = r.exitCode === 0 && r.stdout.text.trim().includes("True");
        } catch {
          /* not installed */
        }
        const name = String(args.hfModelId || "").split("/").pop() || "model";
        const base = "C:/Users/lumin/.baihua/models";
        const outDir = args.outputDir || `${base}/${name}-${args.weightFormat || "int4"}-ov`;
        const task = args.task || config.convertTask;
        const wf = args.weightFormat || "int4";
        const command =
          `${python} -m optimum.cli export openvino --model ${JSON.stringify(args.hfModelId)} --task ${task} ` +
          `--weight-format ${wf} ${JSON.stringify(outDir)}`;
        if (args.dryRun !== false) {
          return {
            check: { hasOptimum },
            command,
            outputDir: outDir,
            executed: false,
            verified: {},
            note: hasOptimum ? "" : "未检测到 optimum/optimum-intel：pip install optimum[openvino]（含 NNCF）。",
          };
        }
        if (!hasOptimum) throw new Error('未安装 optimum[openvino]，无法执行导出：pip install "optimum[openvino]"');
        const r = await shell.run(shell.resolve({
          command,
          timeoutMs: 580000,
          stdoutMaxBytes: 4000000,
          signal: exec.signal,
        }));
        if (r.exitCode !== 0) throw new Error(`导出失败: ${r.stderr.text || r.stdout.text || `exit ${r.exitCode}`}`);
        const ver = {};
        for (const f of ["openvino_model.xml", "openvino_language_model.xml", "openvino_config.json"]) {
          ver[f] = await fileExists(shell, python, `${outDir}/${f}`, exec.signal);
        }
        ver.ok = !!(ver["openvino_model.xml"] || ver["openvino_language_model.xml"]);
        if (!ver.ok) {
          throw new Error(`导出完成但产物校验失败（缺 openvino_model.xml / openvino_language_model.xml）: ${JSON.stringify(ver)}`);
        }
        return { check: { hasOptimum }, command, outputDir: outDir, executed: true, verified: ver };
      },
    }),
  ];

  const disposers = tools.map((t) => ctx.tools.register(t));

  // 只读状态端点（供 client 设置页卡片轮询；与兄弟插件约定一致：留空 token=回环免鉴权）
  const webServer = ctx.webServer;
  let disposeRoute = () => {};
  if (webServer) {
    const authToken = () => config.token || "";
    const authorized = (req) => {
      const st = authToken();
      if (!st) return true;
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.searchParams.get("token") === st) return true;
        const header = req.headers?.authorization;
        return typeof header === "string" && header === `Bearer ${st}`;
      } catch {
        return false;
      }
    };
    disposeRoute = webServer.register({
      kind: "exact",
      path: "/dsh-openvino/status",
      handler: async (req, res) => {
        if (!authorized(req)) {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
          return;
        }
        const shell = getShell();
        const body = { service: "dsh-openvino", ok: true, tools: tools.map((t) => t.name) };
        if (shell) {
          try {
            const python = config.pythonCmd || (await findPython(shell, new AbortController().signal));
            if (python) {
              const report = await runProbe(shell, python, new AbortController().signal);
              body.devices = (report.devices || []).map((d) => `${d.id}=${d.fullName || "?"}`);
              body.openvino = report.openvino;
              body.ovms = report.ovms;
              body.models = (report.models || []).map((m) => ({ name: m.name, type: m.type, sizeGb: m.sizeGb }));
            } else {
              body.python = "not found";
            }
          } catch (e) {
            body.probeError = e instanceof Error ? e.message : String(e);
          }
        } else {
          body.shell = "unavailable";
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
      },
    });
  }

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* noop */
      }
    }
    try {
      disposeRoute();
    } catch {
      /* noop */
    }
  });
  console.log(`[dsh-openvino] OpenVINO Toolkit loaded: ${tools.map((t) => t.name).join(", ")}`);
}
