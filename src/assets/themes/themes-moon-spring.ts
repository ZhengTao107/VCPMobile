export const meta = {
  fileName: 'themes-moon-spring.css',
  name: '月影春信',
};

export const variables = {
  dark: {
  "--chat-wallpaper-dark": "'月影.webp'",
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
  "--panel-text-shadow": "0 1px 3px rgba(0, 0, 0, 0.8)",
  "--panel-bg": "var(--panel-bg-dark)"
},
  light: {
  "--chat-wallpaper-light": "'春信.webp'",
  "--primary-bg": "#fdfaf6",
  "--secondary-bg": "#ffffff",
  "--tertiary-bg": "#f5f0e6",
  "--accent-bg": "#f1ebe1",
  "--border-color": "rgba(225, 91, 91, 0.2)",
  "--input-bg": "#FFFEFE",
  "--panel-bg-light": "rgba(253, 250, 246, 0.85)",
  "--primary-text": "#44403c",
  "--secondary-text": "#78716c",
  "--highlight-text": "#E15B5B",
  "--text-on-accent": "#ffffff",
  "--placeholder-text": "#a8a29e",
  "--quoted-text": "#E15B5B",
  "--user-text": "#44403c",
  "--agent-text": "#44403c",
  "--user-bubble-bg": "rgba(237, 157, 157, 0.9)",
  "--assistant-bubble-bg": "rgba(255, 255, 255, 0.88)",
  "--button-bg": "#E15B5B",
  "--button-hover-bg": "#C04848",
  "--danger-color": "#ef4444",
  "--success-color": "#22c55e",
  "--notification-bg": "#fdfaf6",
  "--notification-border": "#E15B5B",
  "--tool-bubble-bg": "rgba(225, 91, 91, 0.05)",
  "--tool-bubble-border": "#E15B5B",
  "--scrollbar-track": "rgba(0, 0, 0, 0.05)",
  "--scrollbar-thumb": "rgba(225, 91, 91, 0.3)",
  "--scrollbar-thumb-hover": "rgba(225, 91, 91, 0.5)",
  "--shimmer-color-transparent": "rgba(225, 91, 91, 0.05)",
  "--shimmer-color-highlight": "rgba(225, 91, 91, 0.15)",
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
