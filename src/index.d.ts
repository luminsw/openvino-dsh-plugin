/**
 * openvino-dsh-plugin — 类型声明（与实现保持同源，主要供编辑器补全）。
 */
import type { Context } from "@deepseek-ai/cordis";

export interface Config {
  /** 模型目录（默认自动探测 BAIHUA_HOME/models，其次 ~/.baihua/models、~/.openclaw/models）。 */
  modelsDir?: string;
  /** OVMS 基地址。 */
  ovmsUrl?: string;
  /** python 命令（默认自动探测 py -3.12 > python > python3）。 */
  pythonCmd?: string;
  /** openvino_benchmark.py 路径。 */
  benchScriptPath?: string;
  /** 默认导出任务。 */
  convertTask?: string;
}

export declare const name: string;
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").Schema<Config, Config>;
export declare function apply(ctx: Context, config: Config): void;
