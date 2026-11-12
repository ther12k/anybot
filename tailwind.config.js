/** @type {import('tailwindcss').Config} */
// Colors mirror Grok Bot (sand) --sand-* tokens; see src/index.css
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        chrome: "var(--sand-bg-chrome)",
        sidebar: "var(--sand-bg-sidebar)",
        elevated: "var(--sand-bg-elevated)",
        elevatedHover: "var(--sand-bg-elevated-hover)",
        hover: "var(--sand-bg-hover)",
        active: "var(--sand-bg-active)",
        primary: "var(--sand-text-primary)",
        secondary: "var(--sand-text-secondary)",
        tertiary: "var(--sand-text-tertiary)",
        quaternary: "var(--sand-text-quaternary)",
        stroke: "var(--sand-stroke-secondary)",
        strokeStrong: "var(--sand-border-primary-translucent)",
        bubbleUser: "var(--sand-fill-bubble-user)",
        bubbleAgent: "var(--sand-fill-bubble-agent)",
        accent: {
          DEFAULT: "var(--sand-bg-accent-primary)",
          hover: "var(--sand-bg-accent-primary-hover)",
          bright: "var(--sand-bg-accent-bright)",
          soft: "var(--sand-bg-accent-secondary)",
        },
        danger: {
          DEFAULT: "var(--sand-bg-danger-primary)",
          hover: "var(--sand-bg-danger-primary-hover)",
        },
        success: "var(--sand-bg-green-primary)",
      },
      borderRadius: {
        bubble: "18px", // --sand-transcript-prose-bubble-radius
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Inter", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      fontSize: {
        xxs: ["11px", "14px"],
        xs: ["12px", "16px"],
        sm: ["13px", "18px"],
        base: ["14px", "20px"],
        lg: ["15px", "22px"],
      },
    },
  },
  plugins: [],
}
