# openvino-dsh-plugin

把与 **Intel 显卡 + OpenVINO** 打交道的经验沉淀成 DeepSeek Harness (DSH) 运维工具集：
环境一键体检、模型目录扫描、OVMS 注册↔运行状态统一判定、基准测试、HF→OpenVINO 转换（正确量化姿势 + 产物校验）。

与兄弟插件 [`baihua-local-ai-dsh-plugin`](https://github.com/luminsw/baihua-local-ai-dsh-plugin) 职责正交：
**本插件管 Intel/OpenVINO 环境运维（诊断、状态、基准、转换）；local-ai 插件管百花本地 AI 的推理接入（探测能力表 → LLM provider → 小任务工具）**。

## 它能做什么

| 工具 | 说明 |
|---|---|
| `openvino_env_diag` | 一键体检：CPU/GPU/NPU 设备与型号、openvino/openvino_genai 版本、OVMS(:8000) 注册模型、模型目录；给出修复建议（OVMS 未运行→启动方式、模型未注册→configure、NPU 不可见→驱动提示） |
| `openvino_models_scan` | 扫描模型目录（默认 `$BAIHUA_HOME/models`），列出类型（LLM/VL/embedding/other）、精度、架构、大小、是否已注册 OVMS |
| `openvino_status` | 统一状态判定：**OVMS 注册即视为"运行中"**（懒加载语义，沉淀 biancang issue 教训），合并注册 ↔ 目录 ↔ `OmsModelMap`，报告不一致项 |
| `openvino_bench` | 基准测试：包装 `scripts/openvino_benchmark.py`，测加载耗时/TTFT/解码吞吐/端到端吞吐（设备选型与回归） |
| `openvino_convert` | HF→OpenVINO INT4 转换：固化正确姿势（`optimum-cli --weight-format int4` = NNCF，纠正 `load_in_4bit` 误用），可 dry-run 只出命令或实际执行 + 产物校验 |

全部为 **Host 侧只读/生成命令/执行本机 python** 工具，无 UI。

## 安装

本插件是标准 DSH 组合包（`package.json` 声明 `dsh.bundle`），安装后由 profile 组合自动应用其 `cordis.patch.yml` 层：

```bash
dsh plugin --profile web add github:luminsw/openvino-dsh-plugin
```

> 从 git 安装会拉取源码并运行包的 `prepare` 脚本；pnpm ≥ 10 首次需要显式授权
> （`dsh plugin` 会提示把包键加入该 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，然后重新执行 `add`）。

### 本机 link 方式（开发/已 clone 时）

修改 `~/.dsh/profiles/web/package.json` 依赖为 `"openvino-dsh-plugin": "link:../../../src/openvino-dsh-plugin"`，
在该目录跑 `pnpm install`（复用 `profiles/node_modules` junction），重启 DSH 即生效。

### 配置（可选，按 id 覆盖）

在 `$DSH_HOME/cordis.patch.yml` 的 insert 列表按 id 覆盖配置（默认零配置即可用）：

```yaml
    - id: dsh-openvino
      config:
        modelsDir: C:/Users/me/.baihua/models   # 默认自动探测
        pythonCmd: py -3.12                     # 默认自动探测 py -3.12 > python > python3
        benchScriptPath: C:/path/openvino_benchmark.py  # 默认自动探测 ~/src/baihua/scripts/
```

## 验证

```bash
# 独立冒烟（不需要 DSH 上下文；没有 python 也能跑原生段）
node scripts/smoke.mjs
```

DSH 里直接调用工具即可，例如 `openvino_env_diag`（体检）、`openvino_status`（状态判定）、
`openvino_convert`（转换，dry-run 默认）。

## 0.2.0 变更：DSH 0.2.x 适配 + 摆脱 python 依赖

起因：`openvino_status` 报「未找到 python」，但本机明明装了三个 python。排查出三层原因，逐层都改了：

1. **`ctx.shell` 没有 `run()`**。当前契约是 `resolve()` + `execute()`（`execute` 返回 handle，
   `await handle.result()` 拿 `{exitCode, stdout, stderr}`）。旧代码 6 处 `shell.run(...)` 全会抛
   `TypeError`，而 `findPython` 把它吞进 `try/catch`，于是"API 不兼容"被伪装成"没有 python"。
   现在统一走 `runShell()`，并且 **shell API 故障一律如实抛出**，不再降级成"缺 python"。
2. **状态查询不该依赖 python**。新增 `src/native.js`：OVMS 注册走 HTTP（`/v1/models`、`/v1/config`，
   顺带拿到每个模型的 state）、模型目录走 `node:fs`、映射表本来就在 JS 里。
   `openvino_status` / `openvino_models_scan` / `openvino_env_diag` 的核心结论**不再需要 python**；
   只有设备与版本这类非 python 给不出的信息会降级为"未安装 bindings，仅此信息受影响"。
3. **`findPython` 探测面太窄**。现在顺序是：`config.pythonCmd` → `OPENVINO_PYTHON` →
   `ctx.subprocess.resolveExecutable`（provider 的受信 PATH）→ 宿主 PATH 上解析出的绝对路径
   （DSH shell 的 PATH 可能与宿主进程不同，实测本机 `python` 在宿主 PATH 上却在 shell 里解析不到）
   → 常见安装位置 → 字面命令。失败原因去重后最多留几条，不再把同一段报错拼七遍。
4. **执行外部命令改走 `ctx.subprocess`**（`ctx.shell` 作回退）。原因见下面的"已知限制"：
   本机 Windows ACL 沙箱会整体拒绝 shell 执行，而 openvino 的 bench/convert 本来就要读写模型目录，
   只能在宿主权限下跑。`ctx.subprocess` 是 DSH 自己的底层 seam，不套 shell 沙箱，且收 **argv 数组**
   ——顺带消掉了原代码里拼命令字符串的引号隐患（`python -c "..."`、带空格的模型路径）。

顺带修的两个真实误报：

- **模型分类**：OVMS 的 IR 放在 `<模型>/1/openvino_*.xml` 版本子目录里，只查顶层会把
  `Qwen3-4B` 判成 other、把 `Qwen3.5-4B`（含 vision embeddings）判成 LLM。现在递归一层收集 IR，
  按 VL 产物 > 目录名 embedding 线索 > `openvino_language_model.xml` > architectures > 文本 tokenizer
  的顺序判定，单文件 IR 且没有 tokenizer 的（如 TTS Kokoro）归 other。
- **dtype**：`openvino_config.json` 通常不存在，改为回退解析目录名（`-int4-ov` / `-int8-ov`）。

`openvino_convert` 的 dry-run 现在**不需要可用的 python** 也会给出正确命令（只是标注 python 未验证）。

## 已知限制与约定

- `openvino_bench` / `openvino_convert --dryRun=false` 需要可用 python（`openvino_genai` / `optimum`）。
  状态类工具不需要。
- **本机 `ctx.shell` 会被 Windows ACL 沙箱整体拒绝**：错误形如
  `sandbox mode "workspace-write" ... Windows ACL temp root must be outside the workspace`，
  即 TEMP 目录落在 workspace 里面（本机 workspace = `C:\Users\lumin`、TEMP 在其下）。
  这是宿主环境问题，两个修法：把 DSH workspace 收窄到具体项目目录，或把 `TEMP`/`TMP` 指到
  workspace 之外后重启 DSH。**为不受它影响，本插件优先用 `ctx.subprocess`**（不套 shell 沙箱）。
  这是有意的：bench/convert 要读写 GB 级模型目录，只能宿主权限下跑；若将来 DSH 收紧
  subprocess 权限，这里需要重新设计（届时改为遵循会话的 sandboxPolicy）。
- 本机三个 python（OVMS 自带 3.12.10、`Programs\Python312`、Python 3.14.3）都没装 openvino bindings，
  所以 `env_diag` 的设备列表为空、bench/convert 会提示 `pip install`。建议单独建 venv 装，
  再用 `config.pythonCmd` 指过去，不要污染 OVMS 自带那份解释器。
- 模型目录 ↔ OVMS id 映射表 `DIR_TO_OMS`（`src/probe.js`）与百花 `OmsModelMap.cs` 保持一致，新增模型需两个方向同步。
- 模型目录文件被 ACL 保护（如 `PermissionError`）时，先 `icacls "<dir>" /grant "<user>:(OI)(CI)F" /T` 修复。
- `openvino_bench` 加载 7B 模型较耗时（1-5 分钟），属长任务。
