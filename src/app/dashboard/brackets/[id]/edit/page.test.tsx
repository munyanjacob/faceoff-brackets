import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const bracketFindFirst = vi.fn();
const itemFindMany = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst: bracketFindFirst },
    bracketItem: { findMany: itemFindMany },
  },
}));

const { default: EditBracketPage } = await import("./page");

describe("/dashboard/brackets/[id]/edit page", () => {
  beforeEach(() => {
    getUser.mockReset();
    bracketFindFirst.mockReset();
    itemFindMany.mockReset();
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
});
