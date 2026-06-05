import { describe, expect, it } from "vitest";
import { getVisibleModelWindow } from "../ui/Dashboard.js";

describe("getVisibleModelWindow", () => {
  it("scrolls the visible model window to keep the selected model in view", () => {
    const models = Array.from({ length: 30 }, (_, i) => ({ id: `model-${i}` }));

    const window = getVisibleModelWindow(models, 20, 16);

    expect(window.start).toBe(5);
    expect(window.rows.map(model => model.id)).toContain("model-20");
    expect(window.rows[15].id).toBe("model-20");
  });

  it("keeps the first page when the selected model is already visible", () => {
    const models = Array.from({ length: 30 }, (_, i) => ({ id: `model-${i}` }));

    const window = getVisibleModelWindow(models, 4, 16);

    expect(window.start).toBe(0);
    expect(window.rows[0].id).toBe("model-0");
  });
});
