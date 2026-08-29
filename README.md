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
# 独立冒烟（不需要 DSH 上下文；需本机 python + openvino）
node scripts/smoke.mjs
```

DSH 里直接调用工具即可，例如 `openvino_env_diag`（体检）、`openvino_status`（状态判定）、
`openvino_convert`（转换，dry-run 默认）。

## 已知限制与约定

- 工具依赖本机 `python`（openvino / openvino_genai / optimum 按需），未安装时给出明确指引。
- 模型目录 ↔ OVMS id 映射表 `DIR_TO_OMS`（`src/probe.js`）与百花 `OmsModelMap.cs` 保持一致，新增模型需两个方向同步。
- 模型目录文件被 ACL 保护（如 `PermissionError`）时，先 `icacls "<dir>" /grant "<user>:(OI)(CI)F" /T` 修复。
- `openvino_bench` 加载 7B 模型较耗时（1-5 分钟），属长任务。
