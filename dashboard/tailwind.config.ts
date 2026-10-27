import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // ── Apple System Colors ───────────────────────────────────
        apple: {
          blue:   "#007AFF",
          green:  "#34C759",
          red:    "#FF3B30",
          orange: "#FF9500",
          yellow: "#FFCC00",
          purple: "#AF52DE",
          gray:   "#8E8E93",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
      fontSize: {
        // Apple HIG exact type scale
        "apple-largetitle":  ["34px", { lineHeight: "41px", letterSpacing: "-0.4px",  fontWeight: "700" }],
        "apple-title1":      ["28px", { lineHeight: "34px", letterSpacing: "-0.3px",  fontWeight: "700" }],
        "apple-title2":      ["22px", { lineHeight: "28px", letterSpacing: "-0.26px", fontWeight: "700" }],
        "apple-title3":      ["20px", { lineHeight: "25px", letterSpacing: "-0.2px",  fontWeight: "600" }],
        "apple-headline":    ["17px", { lineHeight: "22px", letterSpacing: "-0.4px",  fontWeight: "600" }],
        "apple-body":        ["17px", { lineHeight: "22px", letterSpacing: "-0.4px",  fontWeight: "400" }],
        "apple-callout":     ["16px", { lineHeight: "21px", letterSpacing: "-0.3px",  fontWeight: "400" }],
        "apple-subhead":     ["15px", { lineHeight: "20px", letterSpacing: "-0.2px",  fontWeight: "400" }],
        "apple-footnote":    ["13px", { lineHeight: "18px", letterSpacing: "-0.1px",  fontWeight: "400" }],
        "apple-caption1":    ["12px", { lineHeight: "16px", letterSpacing: "0px",     fontWeight: "400" }],
        "apple-caption2":    ["11px", { lineHeight: "13px", letterSpacing: "0.07px",  fontWeight: "400" }],
      },
      backdropBlur: {
        "apple": "20px",
        "apple-sidebar": "24px",
      },
      boxShadow: {
        // Layered glass shadows
        "apple-card":    "0 2px 8px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.06)",
        "apple-widget":  "0 4px 16px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
        "apple-elevated":"0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)",
        "apple-button":  "0 1px 3px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.2)",
        "apple-inner":   "inset 0 1px 0 rgba(255,255,255,0.6)",
      },
      keyframes: {
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "pulse-ring": {
          "0%":   { transform: "scale(0.95)", opacity: "0.8" },
          "70%":  { transform: "scale(1.3)",  opacity: "0" },
          "100%": { transform: "scale(1.3)",  opacity: "0" },
        },
        "fade-in": {
          "0%":   { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer:      "shimmer 2s infinite linear",
        "pulse-ring": "pulse-ring 1.8s cubic-bezier(0.215, 0.61, 0.355, 1) infinite",
        "fade-in":    "fade-in 0.3s cubic-bezier(0.25, 0.1, 0.25, 1) both",
      },
      transitionTimingFunction: {
        "apple-spring": "cubic-bezier(0.25, 0.1, 0.25, 1.0)",
        "apple-snap":   "cubic-bezier(0.34, 1.56, 0.64, 1.0)",
      },
    },
  },
  plugins: [],
};
export default config;
