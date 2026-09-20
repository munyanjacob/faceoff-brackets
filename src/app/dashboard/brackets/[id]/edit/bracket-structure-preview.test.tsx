import { describe, expect, it } from "vitest";
import { BracketStructurePreview } from "./bracket-structure-preview";

function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i + 1}`,
    title: `Item ${i + 1}`,
  }));
}

/**
 * Unit tests for the pure formatting done by `<BracketStructurePreview>`
 * (issue #15). This is a plain function component (no "use client", no
 * `prisma` import - see the file for why), so it's tested the same way
 * `./page.tsx` is in `./page.test.tsx`: call it directly and inspect the
 * returned React element tree via `JSON.stringify`.
 */
describe("<BracketStructurePreview>", () => {
  it("labels a bye distinctly from a real matchup, not as a matchup against a blank opponent", () => {
    // 3 items -> next power of two is 4, so 1 bye (Item 1) + 1 matchup
    // (Item 2 vs Item 3), per generateFirstRound's (#17) seeding rules.
    const result = BracketStructurePreview({ items: items(3) });
    const html = JSON.stringify(result);

    expect(html).toContain("Item 1 — Bye (advances automatically)");
    expect(html).toContain("Item 2 vs Item 3");

    // The bye entry must not read as a matchup against a blank/empty
    // opponent - it never appears with "vs".
    expect(html).not.toContain("Item 1 vs");
  });

  it("shows every item as a real matchup when the count is already a power of two (no byes)", () => {
    const result = BracketStructurePreview({ items: items(4) });
    const html = JSON.stringify(result);

    expect(html).toContain("Item 1 vs Item 2");
    expect(html).toContain("Item 3 vs Item 4");
    expect(html).not.toMatch(/Bye/);
  });

  it("shows a clear message instead of a broken/empty structure with 0 items", () => {
    const result = BracketStructurePreview({ items: items(0) });
    const html = JSON.stringify(result);

    expect(html).toMatch(/needs at least 2 items/i);
  });

  it("shows a clear message instead of a broken/empty structure with 1 item", () => {
    const result = BracketStructurePreview({ items: items(1) });
    const html = JSON.stringify(result);

    expect(html).toMatch(/needs at least 2 items/i);
    // Must not attempt to call generateFirstRound (which throws below 2
    // items) - if it did, this component would throw instead of render.
  });

  it("recomputes from whatever items prop it's given - two calls with different item lists produce different structures, proving there's no stale caching", () => {
    const before = JSON.stringify(BracketStructurePreview({ items: items(2) }));
    const after = JSON.stringify(
      BracketStructurePreview({ items: items(3) })
    );

    expect(before).toContain("Item 1 vs Item 2");
    expect(before).not.toMatch(/Bye/);

    // Simulates an item having been added (#11) and the preview being
    // reopened: the same component, called again, reflects the new list.
    expect(after).toContain("Item 1 — Bye (advances automatically)");
    expect(after).toContain("Item 2 vs Item 3");
  });
});
