import { describe, it, expect } from "vitest";
import { makeStyler, colorsEnabled, styleDeltaSummary, styleLockedIn } from "../src/style.js";

describe("makeStyler", () => {
  it("wraps in ANSI when enabled", () => {
    const s = makeStyler(true);
    expect(s.green("ok")).toBe("\x1b[32mok\x1b[0m");
    expect(s.red("x")).toBe("\x1b[31mx\x1b[0m");
  });

  it("is a no-op passthrough when disabled (piped output / tests stay plain)", () => {
    const s = makeStyler(false);
    expect(s.green("ok")).toBe("ok");
    expect(s.bold(s.red("x"))).toBe("x");
  });
});

describe("colorsEnabled", () => {
  it("NO_COLOR (any value, even empty) disables", () => {
    expect(colorsEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorsEnabled({ NO_COLOR: "" }, true)).toBe(false);
  });
  it("FORCE_COLOR enables even without a TTY", () => {
    expect(colorsEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
  });
  it("otherwise follows the TTY", () => {
    expect(colorsEnabled({}, true)).toBe(true);
    expect(colorsEnabled({}, false)).toBe(false);
  });
  it("CLICOLOR_FORCE=1 forces on without a TTY (tmux/ssh)", () => {
    expect(colorsEnabled({ CLICOLOR_FORCE: "1" }, false)).toBe(true);
  });
  it("an explicit override (--color/--no-color) wins over TTY detection", () => {
    expect(colorsEnabled({}, false, true)).toBe(true); // --color on a non-TTY
    expect(colorsEnabled({}, true, false)).toBe(false); // --no-color on a TTY
  });
  it("NO_COLOR still beats an explicit --color override", () => {
    expect(colorsEnabled({ NO_COLOR: "1" }, true, true)).toBe(false);
  });
});

describe("styleDeltaSummary", () => {
  it("plain when disabled: + adds, - removes, ~ modifies, with drift marker", () => {
    const s = makeStyler(false);
    const out = styleDeltaSummary(
      [
        { op: "add", section: "requirements", id: "R2" },
        { op: "remove", section: "requirements", id: "R1" },
        { op: "modify", section: "thesis", drift: true },
      ],
      s,
    );
    expect(out).toBe("+requirements:R2 -requirements:R1 ~thesis⚠drift");
  });

  it("colors each op when enabled", () => {
    const s = makeStyler(true);
    const out = styleDeltaSummary([{ op: "add", section: "claims", id: "C1" }], s);
    expect(out).toContain("\x1b[32m+claims:C1\x1b[0m"); // green add
  });
});

describe("styleLockedIn", () => {
  it("says what was decided/recorded in plain words, not structural tokens", () => {
    const s = makeStyler(false);
    const out = styleLockedIn(
      [
        { op: "add", section: "decisions", value: { statement: "storage = SQLite" } },
        { op: "resolve", section: "open_questions", id: "Q1" },
        { op: "add", section: "requirements", value: { statement: "voice loop" } },
      ],
      s,
    );
    expect(out).toContain("decided: storage = SQLite");
    expect(out).toContain("resolved ✓");
    expect(out).toContain("+req: voice loop");
  });
});
