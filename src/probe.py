#!/usr/bin/env python3
"""OpenVINO 工具箱探测脚本：设备/版本/OVMS/模型目录一次输出 JSON。

由 openvino-dsh-plugin 的 runProbe() 以 `python <本文件>` 方式执行。
注意：不要改用 stdin（`python -`）传脚本——DSH shell 服务下 stdin 模式
退出码异常（exit 1 且 stderr 空），文件方式稳定 exit 0。
"""
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