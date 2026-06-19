import { describe, it, expect } from "vitest";
import { isVisualAppSpec, withFrontendFloorStories, FRONTEND_FLOOR_STORIES } from "../../src/review/frontend-floor.js";

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
});
