/**
 * probe.js — OpenVINO 探测核心。
 *
 * 职责：
 *  - 维护一份嵌入的 Python 探测脚本（设备/版本/OVMS/模型目录一次输出 JSON）；
 *  - findPython：探测本机可用的 python 命令（py -3.12 > python > python3）；
 *  - runProbe：通过 stdin 把脚本喂给 `python -`，解析 JSON 报告；
 *  - fileExists：跨 shell 方言安全的文件存在性探测（同样走 python stdin）；
 *  - DIR_TO_OMS / OMS_TO_DIR：模型目录名 ↔ OVMS servable id 映射（对齐百花
 *    Baihua.AI.Provider.OpenVino/OmsModelMap.cs，新增模型时两个方向都要补）。
 *
 * 全部探测静默容错：任何服务不可达 / 文件不可读都不影响工具执行，结果如实反映。
 */
export const PROBE = `#!/usr/bin/env python3
import json, os, platform, sys, urllib.request

def find_models_dir():
    env = os.environ.get("BAIHUA_HOME") or ""
    if env:
        p = os.path.join(env, "models")
        if os.path.isdir(p):
            return p
    for p in (os.path.expanduser("~/.baihua/models"), os.path.expanduser("~/.openclaw/models")):
        if os.path.isdir(p):
            return p
    return None

def ovms_models(base="http://127.0.0.1:8000"):
    try:
        with urllib.request.urlopen(base + "/v1/models", timeout=3) as r:
            data = json.loads(r.read().decode("utf-8"))
            return [m.get("id") for m in (data.get("data") or []) if m.get("id")]
    except Exception as e:
        return {"error": type(e).__name__ + ": " + str(e)}

def classify(entry):
    archs = entry.get("arch") or []
    s = " ".join(archs) if isinstance(archs, list) else str(archs)
    if entry.get("hasVision"):
        return "VL"
    if entry.get("hasLang"):
        return "LLM"
    if "ForCausalLM" in s or "LMHead" in s or "ForConditionalGeneration" in s:
        return "LLM"
    if "BertModel" in s or "Model" in s or "ForMaskedLM" in s:
        return "embedding"
    return "other"

def scan_models(models_dir):
    out = []
    if not models_dir:
        return out
    for name in sorted(os.listdir(models_dir)):
        d = os.path.join(models_dir, name)
        if not os.path.isdir(d):
            continue
        entry = {"name": name, "hasLang": False, "hasVision": False, "hasEmbed": False, "dtype": None, "arch": None, "sizeGb": None}
        entry["hasLang"] = os.path.exists(os.path.join(d, "openvino_language_model.xml"))
        entry["hasVision"] = os.path.exists(os.path.join(d, "openvino_vision_embeddings_model.xml"))
        entry["hasEmbed"] = os.path.exists(os.path.join(d, "openvino_model.bin"))
        for f in ("config.json", "openvino_config.json"):
            fp = os.path.join(d, f)
            if os.path.exists(fp):
                try:
                    with open(fp, "r", encoding="utf-8") as fh:
                        cj = json.load(fh)
                    if f == "config.json":
                        entry["arch"] = cj.get("architectures") or cj.get("model_type")
                    else:
                        entry["dtype"] = cj.get("weight_format") or cj.get("dtype")
                except Exception:
                    pass
        try:
            total = sum(os.path.getsize(os.path.join(r, fn)) for r, _, files in os.walk(d) for fn in files)
            entry["sizeGb"] = round(total / 1024 ** 3, 2)
        except Exception:
            pass
        entry["type"] = classify(entry)
        out.append(entry)
    return out

def main():
    devices = []
    ov = {}
    try:
        import openvino as _ov
        core = _ov.Core()
        ov["version"] = _ov.__version__
        for dd in core.available_devices:
            full = ""
            try:
                full = core.get_property(dd, "FULL_DEVICE_NAME")
            except Exception:
                pass
            devices.append({"id": dd, "fullName": full})
    except Exception as e:
        ov["error"] = type(e).__name__ + ": " + str(e)
    try:
        import openvino_genai as g
        ov["genai"] = getattr(g, "__version__", "unknown")
    except Exception as e:
        ov["genaiError"] = type(e).__name__ + ": " + str(e)
    models_dir = find_models_dir()
    print(json.dumps({
        "ok": True,
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine(), "python": sys.version.split()[0]},
        "openvino": ov,
        "devices": devices,
        "ovms": ovms_models(),
        "modelsDir": models_dir,
        "models": scan_models(models_dir),
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
`;

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
 * 通过 stdin 运行探测脚本并解析 JSON 报告。
 * @param {object} shell
 * @param {string} python
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
export async function runProbe(shell, python, signal) {
  const r = await shell.run(shell.resolve({
    command: `${python} -`,
    timeoutMs: 60000,
    stdoutMaxBytes: 2000000,
    signal,
    stdin: PROBE,
  }));
  if (r.exitCode !== 0) throw new Error(`探测失败: ${r.stderr.text || `exit ${r.exitCode}`}`);
  return JSON.parse(r.stdout.text);
}

/** 跨 shell 方言安全的文件存在探测（python 实现，Windows/Linux 均可用）。 */
export async function fileExists(shell, python, path, signal) {
  const r = await shell.run(shell.resolve({
    command: `${python} - ${JSON.stringify(path)}`,
    timeoutMs: 8000,
    signal,
    stdin: "import os,sys\nprint(os.path.exists(sys.argv[1]))\n",
  }));
  return r.exitCode === 0 && r.stdout.text.trim().toLowerCase().startsWith("true");
}
