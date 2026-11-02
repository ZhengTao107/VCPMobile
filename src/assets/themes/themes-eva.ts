export const meta = {
  fileName: 'themes-eva.css',
  name: 'Eva',
};

export const variables = {
  dark: {
  "--chat-wallpaper-dark": "'eva-dark.webp'",
  "--primary-bg": "#0f172a",
  "--secondary-bg": "#1e293b",
  "--tertiary-bg": "#020617",
  "--accent-bg": "#334155",
  "--border-color": "rgba(233, 196, 106, 0.4)",
  "--input-bg": "#0F172A",
  "--panel-bg-dark": "rgba(15, 23, 42, 0.75)",
  "--primary-text": "#f1f5f9",
  "--secondary-text": "#94a3b8",
  "--highlight-text": "#E9C46A",
  "--text-on-accent": "#0f172a",
  "--placeholder-text": "#475569",
  "--quoted-text": "#FDE68A",
  "--user-text": "#f1f5f9",
  "--agent-text": "#f1f5f9",
  "--user-bubble-bg": "rgba(108, 107, 87, 0.9)",
  "--assistant-bubble-bg": "rgba(30, 41, 59, 0.88)",
  "--button-bg": "#E9C46A",
  "--button-hover-bg": "#D4A373",
  "--danger-color": "#f87171",
  "--success-color": "#4ade80",
  "--notification-bg": "#1e293b",
  "--notification-border": "#FDE68A",
  "--tool-bubble-bg": "rgba(253, 230, 138, 0.05)",
  "--tool-bubble-border": "#FDE68A",
  "--scrollbar-track": "rgba(15, 23, 42, 0.3)",
  "--scrollbar-thumb": "rgba(253, 230, 138, 0.3)",
  "--scrollbar-thumb-hover": "rgba(253, 230, 138, 0.5)",
  "--shimmer-color-transparent": "rgba(253, 230, 138, 0.1)",
  "--shimmer-color-highlight": "rgba(253, 230, 138, 0.3)",
  "--panel-text-shadow": "none",
  "--panel-bg": "var(--panel-bg-dark)"
},
  light: {
  "--chat-wallpaper-light": "'eva-light.webp'",
  "--primary-bg": "#fafafa",
  "--secondary-bg": "#ffffff",
  "--tertiary-bg": "#f5f5f5",
  "--accent-bg": "#ffeaea",
  "--border-color": "rgba(255, 62, 95, 0.3)",
  "--input-bg": "#FFFFFF",
  "--panel-bg-light": "rgba(255, 255, 255, 0.6)",
  "--primary-text": "#2d2d30",
  "--secondary-text": "#6a6a70",
  "--highlight-text": "#ff3e5f",
  "--text-on-accent": "#ffffff",
  "--placeholder-text": "#a0a0a8",
  "--quoted-text": "#ff3e5f",
  "--user-text": "#2d2d30",
  "--agent-text": "#2d2d30",
  "--user-bubble-bg": "rgba(255, 139, 159, 0.9)",
  "--assistant-bubble-bg": "rgba(255, 255, 255, 0.88)",
  "--button-bg": "#ff3e5f",
  "--button-hover-bg": "#ff1f45",
  "--danger-color": "#ef4444",
  "--success-color": "#22c55e",
  "--notification-bg": "#ffffff",
  "--notification-border": "#ff3e5f",
  "--tool-bubble-bg": "rgba(255, 62, 95, 0.08)",
  "--tool-bubble-border": "#ff3e5f",
  "--scrollbar-track": "rgba(0, 0, 0, 0.08)",
  "--scrollbar-thumb": "rgba(255, 62, 95, 0.4)",
  "--scrollbar-thumb-hover": "rgba(255, 62, 95, 0.6)",
  "--shimmer-color-transparent": "rgba(255, 62, 95, 0.08)",
  "--shimmer-color-highlight": "rgba(255, 62, 95, 0.2)",
  "--panel-text-shadow": "none",
  "--panel-bg": "var(--panel-bg-light)"
},
};

export const extraCss = `
.tool-bubble {
    border: 1px solid var(--tool-bubble-border);
    background: var(--tool-bubble-bg);
}
`;
