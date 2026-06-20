import { describe, it, expect } from "vitest";
import { isVisualAppSpec, withFrontendFloorStories, withUiRequirement, FRONTEND_FLOOR_STORIES } from "../../src/review/frontend-floor.js";

describe("frontend floor heuristics", () => {
  it("detects a visual dashboard spec", () => {
    expect(isVisualAppSpec({
      thesis: "a web dashboard for sportsbook arbitrage",
      stories: ["a user opens the dashboard and sees ranked opportunities"],
    })).toBe(true);
  });

  it("does not classify a CLI/library spec as a visual app", () => {
    expect(isVisualAppSpec({
      thesis: "a CLI to sync API schemas into a library package",
      stories: ["a developer runs the CLI and gets a JSON report"],
    })).toBe(false);
  });

  it("appends the frontend floor stories once", () => {
    const spec = withFrontendFloorStories({
      thesis: "a web app",
      stories: ["a user sees a ranked list"],
      extra: 1,
    });
    expect(spec.stories).toEqual(["a user sees a ranked list", ...FRONTEND_FLOOR_STORIES]);
    expect(withFrontendFloorStories(spec).stories).toEqual(spec.stories);
  });

  it("injects one gated UI requirement when a visual app has only logic requirements", () => {
    const spec = withUiRequirement({
      thesis: "a flashcard app for studying",
      stories: ["a student studies due cards"],
      requirements: [
        { id: "R1", statement: "deck and card management", acceptance: { tier: 1, gate: "npm test -- decks" } },
        { id: "R2", statement: "spaced repetition scheduler", acceptance: { tier: 1, gate: "npm test -- sched" } },
      ],
    });
    expect(spec.requirements).toHaveLength(3);
    const ui = spec.requirements[2]!;
    expect(ui.id).toBe("R3");
    expect(ui.statement).toMatch(/index\.html/);
    expect(ui.acceptance.gate).toBe("npm run build --if-present"); // build floor; visual audit carries the teeth
  });

  it("does not double-inject a UI requirement (idempotent) or touch non-visual specs", () => {
    const withUi = {
      thesis: "a web app",
      stories: ["x"],
      requirements: [{ id: "R1", statement: "the app renders the UI in index.html", acceptance: { tier: 1 as const, gate: "npm run build" } }],
    };
    expect(withUiRequirement(withUi).requirements).toHaveLength(1); // already has a UI req
    const cli = { thesis: "a CLI library package", stories: ["dev runs it"], requirements: [] };
    expect(withUiRequirement(cli).requirements).toHaveLength(0); // not a visual app
  });
});
