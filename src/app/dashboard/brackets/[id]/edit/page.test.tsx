import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const bracketFindFirst = vi.fn();
const itemFindMany = vi.fn();

// Write spies on every model this page's data could plausibly reach,
// covering issue #15's "viewing this preview creates no database rows"
// criterion concretely rather than only by code inspection: see the
// "renders the structure preview without writing to the database" test
// below.
const bracketCreate = vi.fn();
const bracketUpdate = vi.fn();
const bracketDelete = vi.fn();
const itemCreate = vi.fn();
const itemUpdate = vi.fn();
const itemDelete = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: {
      findFirst: bracketFindFirst,
      create: bracketCreate,
      update: bracketUpdate,
      delete: bracketDelete,
    },
    bracketItem: {
      findMany: itemFindMany,
      create: itemCreate,
      update: itemUpdate,
      delete: itemDelete,
    },
  },
}));

const { default: EditBracketPage } = await import("./page");

describe("/dashboard/brackets/[id]/edit page", () => {
  beforeEach(() => {
    getUser.mockReset();
    bracketFindFirst.mockReset();
    itemFindMany.mockReset();
    bracketCreate.mockReset();
    bracketUpdate.mockReset();
    bracketDelete.mockReset();
    itemCreate.mockReset();
    itemUpdate.mockReset();
    itemDelete.mockReset();
    getUser.mockResolvedValue({
      data: { user: { id: "creator-1" } },
      error: null,
    });
    itemFindMany.mockResolvedValue([]);
  });

  it("looks the bracket up scoped to the signed-in creator, not by id alone", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
    });

    await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    expect(bracketFindFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "creator-1" },
    });
  });

  it("looks its items up scoped to this bracket, not another one", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
    });

    await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    expect(itemFindMany).toHaveBeenCalledWith({
      where: { bracketId: "bracket-1" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("renders the bracket's title and its existing items", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
    });
    itemFindMany.mockResolvedValue([
      { id: "item-1", title: "Seinfeld", description: "The one about nothing." },
      { id: "item-2", title: "Cheers", description: null },
    ]);

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).toContain("Best Sitcom");
    expect(html).toContain("Seinfeld");
    expect(html).toContain("The one about nothing.");
    expect(html).toContain("Cheers");
  });

  it("passes each item's imageUrl through to its row, so an uploaded image can render in the list (issue #12)", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
    });
    itemFindMany.mockResolvedValue([
      {
        id: "item-1",
        title: "Seinfeld",
        description: null,
        imageUrl: "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/seinfeld.png",
      },
      { id: "item-2", title: "Cheers", description: null, imageUrl: null },
    ]);

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).toContain(
      "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/seinfeld.png"
    );
  });

  it("renders an explicit empty state when the bracket has no items yet", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
    });

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).toMatch(/no items yet/i);
  });

  it("passes isDraft: true to each item row and includes the add-item form while the bracket is a DRAFT", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
    });
    itemFindMany.mockResolvedValue([
      { id: "item-1", title: "Seinfeld", description: null },
    ]);

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).toContain('"isDraft":true');
    // The add-item form's bracketId prop, proving <AddItemForm> was
    // included rather than the "no longer a draft" message.
    expect(html).toContain('"bracketId":"bracket-1"');
  });

  it("passes isDraft: false to each item row and omits the add-item form once the bracket is no longer a DRAFT", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "ACTIVE",
    });
    itemFindMany.mockResolvedValue([
      { id: "item-1", title: "Seinfeld", description: null },
    ]);

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).toContain('"isDraft":false');
    expect(html).toMatch(/no longer a draft/i);
  });

  it("passes the live item-count-derived total rounds and parsed overrides to the round duration form while a DRAFT", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
      defaultRoundDurationMinutes: 90,
      roundDurationOverrides: { "2": 45 },
    });
    itemFindMany.mockResolvedValue([
      { id: "item-1", title: "A", description: null },
      { id: "item-2", title: "B", description: null },
      { id: "item-3", title: "C", description: null },
      { id: "item-4", title: "D", description: null },
    ]);

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    // 4 items -> ceil(log2(4)) = 2 rounds.
    expect(html).toContain('"totalRounds":2');
    expect(html).toContain('"defaultRoundDurationMinutes":90');
    expect(html).toContain('"overrides":{"2":45}');
  });

  it("does not crash rendering a bracket whose stored overrides include a round number beyond the current total", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
      defaultRoundDurationMinutes: 60,
      // Stale: was set back when there were more items.
      roundDurationOverrides: { "5": 999 },
    });
    itemFindMany.mockResolvedValue([
      { id: "item-1", title: "A", description: null },
    ]);

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).toContain('"totalRounds":0');
    // Carried through as-is (harmless - just never rendered as a round
    // input row since totalRounds is 0); this issue's job is only to not
    // crash on it, per the acceptance criteria and #18.
    expect(html).toContain('"overrides":{"5":999}');
  });

  it("omits the round duration form and shows a locked message once the bracket is no longer a DRAFT", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "ACTIVE",
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
    });

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).not.toContain("defaultRoundDurationMinutes");
    expect(html).toMatch(/round duration can.t be changed/i);
  });

  it("passes the bracket's scheduledStartAt to the scheduled start form while a DRAFT", async () => {
    const scheduledStartAt = new Date("2030-01-01T09:00:00.000Z");
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
      scheduledStartAt,
    });

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).toContain(scheduledStartAt.toISOString());
  });

  it("passes a null scheduledStartAt to the scheduled start form for a bracket with no scheduled start yet", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "DRAFT",
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
      scheduledStartAt: null,
    });

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).toContain('"scheduledStartAt":null');
  });

  it("omits the scheduled start form and shows a locked message once the bracket is no longer a DRAFT", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      title: "Best Sitcom",
      status: "ACTIVE",
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
      scheduledStartAt: null,
    });

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).not.toContain("scheduledStartAt");
    expect(html).toMatch(/start time can.t be changed/i);
  });

  it("404s instead of leaking a bracket that doesn't belong to the signed-in creator", async () => {
    bracketFindFirst.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await EditBracketPage({
        params: Promise.resolve({ id: "someone-elses-bracket" }),
        searchParams: Promise.resolve({}),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("404");
    expect(itemFindMany).not.toHaveBeenCalled();
  });

  // Issue #15: the "Preview structure" view. Like the rest of this file,
  // these call the Server Component function directly rather than actually
  // rendering it, so nested function components (`<BracketStructurePreview>`
  // included) show up as an unrendered element - only its `props` (not its
  // internal JSX) serialize. That's exactly what's under test here: that
  // `./page.tsx` wires the live, just-queried `items` straight through to
  // `<BracketStructurePreview>` on every call, with no re-query, caching, or
  // staleness in between. The preview's own rendering behavior (bye
  // labeling, the <2 items message, recomputing from its `items` prop) is
  // unit-tested directly in `./bracket-structure-preview.test.tsx`.
  describe("structure preview", () => {
    it("passes the current, live items straight through to the structure preview", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        title: "Best Sitcom",
        status: "DRAFT",
      });
      itemFindMany.mockResolvedValue([
        { id: "item-1", title: "Seinfeld", description: null, imageUrl: null },
        { id: "item-2", title: "Cheers", description: null, imageUrl: null },
        { id: "item-3", title: "Frasier", description: null, imageUrl: null },
      ]);

      const result = await EditBracketPage({
        params: Promise.resolve({ id: "bracket-1" }),
        searchParams: Promise.resolve({}),
      });

      const html = JSON.stringify(result);
      expect(html).toContain(
        '"items":[{"id":"item-1","title":"Seinfeld","description":null,"imageUrl":null},' +
          '{"id":"item-2","title":"Cheers","description":null,"imageUrl":null},' +
          '{"id":"item-3","title":"Frasier","description":null,"imageUrl":null}]'
      );
    });

    it("still passes the (short) item list through when there are fewer than 2 items, rather than skipping the preview", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        title: "Best Sitcom",
        status: "DRAFT",
      });
      itemFindMany.mockResolvedValue([
        { id: "item-1", title: "Seinfeld", description: null, imageUrl: null },
      ]);

      const result = await EditBracketPage({
        params: Promise.resolve({ id: "bracket-1" }),
        searchParams: Promise.resolve({}),
      });

      const html = JSON.stringify(result);
      expect(html).toContain(
        '"items":[{"id":"item-1","title":"Seinfeld","description":null,"imageUrl":null}]'
      );
    });

    it("passes a fresh items array on every call, reflecting an item added/removed since the last one - not a stale, cached list", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        title: "Best Sitcom",
        status: "DRAFT",
      });

      // First "open": two items.
      itemFindMany.mockResolvedValue([
        { id: "item-1", title: "Seinfeld", description: null, imageUrl: null },
        { id: "item-2", title: "Cheers", description: null, imageUrl: null },
      ]);
      const firstOpen = await EditBracketPage({
        params: Promise.resolve({ id: "bracket-1" }),
        searchParams: Promise.resolve({}),
      });
      expect(JSON.stringify(firstOpen)).toContain(
        '"items":[{"id":"item-1","title":"Seinfeld","description":null,"imageUrl":null},' +
          '{"id":"item-2","title":"Cheers","description":null,"imageUrl":null}]'
      );

      // An item is added (#11) between opens - re-invoking the same page
      // function the way a fresh request/revalidation would must reflect
      // the new list, not the one captured above.
      itemFindMany.mockResolvedValue([
        { id: "item-1", title: "Seinfeld", description: null, imageUrl: null },
        { id: "item-2", title: "Cheers", description: null, imageUrl: null },
        { id: "item-3", title: "Frasier", description: null, imageUrl: null },
      ]);
      const secondOpen = await EditBracketPage({
        params: Promise.resolve({ id: "bracket-1" }),
        searchParams: Promise.resolve({}),
      });
      const secondHtml = JSON.stringify(secondOpen);
      expect(secondHtml).toContain('"id":"item-3","title":"Frasier"');
      expect(secondHtml).not.toBe(JSON.stringify(firstOpen));
    });

    it("renders the page (structure preview included) without creating, updating, or deleting any database rows", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        title: "Best Sitcom",
        status: "DRAFT",
      });
      itemFindMany.mockResolvedValue([
        { id: "item-1", title: "Seinfeld", description: null, imageUrl: null },
        { id: "item-2", title: "Cheers", description: null, imageUrl: null },
        { id: "item-3", title: "Frasier", description: null, imageUrl: null },
      ]);

      const result = await EditBracketPage({
        params: Promise.resolve({ id: "bracket-1" }),
        searchParams: Promise.resolve({}),
      });

      // Sanity check the preview is actually in the tree (its `items` prop
      // present), so this test would fail loudly if the wiring broke
      // instead of passing vacuously.
      expect(JSON.stringify(result)).toContain('"id":"item-3","title":"Frasier"');

      expect(bracketCreate).not.toHaveBeenCalled();
      expect(bracketUpdate).not.toHaveBeenCalled();
      expect(bracketDelete).not.toHaveBeenCalled();
      expect(itemCreate).not.toHaveBeenCalled();
      expect(itemUpdate).not.toHaveBeenCalled();
      expect(itemDelete).not.toHaveBeenCalled();
    });
  });
});
