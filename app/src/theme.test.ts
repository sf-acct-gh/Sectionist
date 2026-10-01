// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyTheme, BUILTIN_THEMES, DEFAULT_THEME_ID, getThemeById, REQUIRED_COLOR_KEYS, validateTheme } from "./theme";

describe("validateTheme", () => {
  const validColors = Object.fromEntries(REQUIRED_COLOR_KEYS.map((key) => [key, "#000000"]));

  it("accepts a well-formed theme", () => {
    const theme = validateTheme({ id: "x", name: "X", scheme: "light", colors: validColors });
    expect(theme).not.toBeNull();
    expect(theme?.id).toBe("x");
  });

  it("rejects a theme missing a required color key", () => {
    const { text: _text, ...incomplete } = validColors;
    const theme = validateTheme({ id: "x", name: "X", scheme: "light", colors: incomplete });
    expect(theme).toBeNull();
  });

  it("rejects a theme with a malformed (empty string) color value", () => {
    const theme = validateTheme({
      id: "x",
      name: "X",
      scheme: "light",
      colors: { ...validColors, text: "" },
    });
    expect(theme).toBeNull();
  });

  it("rejects a theme with an invalid scheme value", () => {
    const theme = validateTheme({ id: "x", name: "X", scheme: "blue", colors: validColors });
    expect(theme).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(validateTheme(null)).toBeNull();
    expect(validateTheme("light")).toBeNull();
    expect(validateTheme(undefined)).toBeNull();
  });

  it("rejects a theme with a missing id or name", () => {
    expect(validateTheme({ name: "X", scheme: "light", colors: validColors })).toBeNull();
    expect(validateTheme({ id: "x", scheme: "light", colors: validColors })).toBeNull();
  });

  it("every built-in theme is valid and self-contained", () => {
    for (const theme of BUILTIN_THEMES) {
      expect(validateTheme(theme)).not.toBeNull();
    }
  });
});

describe("applyTheme", () => {
  it("sets every required color as a CSS custom property on the document root", () => {
    const root = document.documentElement;
    const theme = getThemeById("dark");

    const ok = applyTheme(theme);

    expect(ok).toBe(true);
    for (const key of REQUIRED_COLOR_KEYS) {
      expect(root.style.getPropertyValue(`--${key}`)).toBe(theme.colors[key]);
    }
    expect(root.style.colorScheme).toBe("dark");
  });

  it("leaves prior custom properties untouched when given an invalid theme", () => {
    const root = document.documentElement;
    applyTheme(getThemeById("light"));
    const before = root.style.getPropertyValue("--text");

    const ok = applyTheme({ id: "bad", name: "Bad", scheme: "light", colors: {} });

    expect(ok).toBe(false);
    expect(root.style.getPropertyValue("--text")).toBe(before);
  });
});

describe("getThemeById", () => {
  it("falls back to the default theme for an unknown id", () => {
    expect(getThemeById("nonexistent").id).toBe(DEFAULT_THEME_ID);
  });

  it("returns every built-in theme by its own id", () => {
    for (const theme of BUILTIN_THEMES) {
      expect(getThemeById(theme.id).id).toBe(theme.id);
    }
  });
});
