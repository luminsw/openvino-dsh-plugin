/**
 * openvino-dsh-plugin 客户端模块（DSH Web UI 侧）。
 *
 * 由 DSH 客户端模块系统按 lazy-CJS factory 格式加载（window.__ModuleLoader__.load）。
 * 作用：在 DSH 设置 → 插件页注册一张「OpenVINO 环境」卡片——顶部展示
 * OpenVINO/OVMS 环境状态摘要（设备、openvino 版本、OVMS 注册模型、模型目录），
 * 每 15s 自动刷新；数据源 GET /dsh-openvino/status（只读）。
 * 工具本身（openvino_env_diag 等）由 host 侧注册，无需此卡片即可使用。
 */
window.__ModuleLoader__.load({
  id: "openvino-dsh-plugin",
  factory(require) {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const STATUS_URL = "/dsh-openvino/status";

    const base = {
      fontFamily: "inherit",
      fontSize: 13,
      lineHeight: 1.6,
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-layer-3)",
      borderRadius: 14,
      boxShadow: "0 2px 8px rgba(0,0,0,.14)",
      padding: "14px 16px",
    };

    function OpenVinoStatusCard(props) {
      // summary 只用于行描述兜底（bundle 配置页只渲染 page）
      if (props.view === "summary") {
        return React.createElement("span", null, "本机 Intel GPU / OpenVINO 环境状态（openvino_env_diag 等工具）");
      }
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);

      const load = useCallback(async () => {
        try {
          const res = await fetch(STATUS_URL, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setStatus(await res.json());
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }, []);

      useEffect(() => {
        load();
        const timer = setInterval(load, 15000);
        return () => clearInterval(timer);
      }, [load]);

      const title = React.createElement(
        "span",
        { style: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)" } },
        "OpenVINO 环境",
      );
      const subtitle = React.createElement(
        "span",
        { style: { fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" } },
        "本机 Intel GPU / OpenVINO 状态。工具：openvino_env_diag / models_scan / status / bench / convert",
      );
      const header = React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 2 } },
        title,
        subtitle,
      );

      let body;
      if (error) {
        body = React.createElement(
          "div",
          { style: { marginTop: 10, fontSize: 12, color: "#c0392b" } },
          `状态获取失败：${error}`,
        );
      } else if (!status) {
        body = React.createElement("div", { style: { marginTop: 10, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, "加载中…");
      } else {
        const rows = [];
        rows.push(["设备", (status.devices || []).join(" | ") || "无"]);
        if (status.openvino) {
          rows.push(["openvino", status.openvino.version || "?"]);
          rows.push(["genai", status.openvino.genai || "?"]);
          if (status.openvino.error) rows.push(["openvino error", status.openvino.error]);
        }
        rows.push(["OVMS 注册", Array.isArray(status.ovms) ? status.ovms.join(", ") : String(status.ovms || "")]);
        rows.push(["模型", (status.models || []).map((m) => `${m.name} [${m.type}]`).join("，") || "无"]);
        if (status.python === "not found") rows.push(["python", "未找到（工具不可用）"]);
        if (status.shell === "unavailable") rows.push(["shell", "不可用"]);
        if (status.probeError) rows.push(["探测错误", status.probeError]);
        body = React.createElement(
          "div",
          { style: { marginTop: 10, display: "flex", flexDirection: "column", gap: 4 } },
          rows.map(([k, v]) =>
            React.createElement(
              "div",
              { key: k, style: { display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5 } },
              React.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", minWidth: 90, flex: "none" } }, k),
              React.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", wordBreak: "break-all" } }, v)
            )
          )
        );
      }

      return React.createElement("div", { style: base }, header, body);
    }

    return {
      name: "dsh-openvino-client",
      inject: ["slots"],
      apply(ctx) {
        // DSH 0.2.x：卡片挂在「插件」页里本 bundle 自己的页面上
        // （plugins.bundle.config，key = 包名）；旧版 settings.plugin.item 槽位已删除。
        ctx.slots.inject("plugins.bundle.config", function* () {
          yield ctx.slots.register(
            {
              name: "plugins.bundle.config",
              key: "openvino-dsh-plugin",
            },
            OpenVinoStatusCard
          );
        });
      },
    };
  },
});
