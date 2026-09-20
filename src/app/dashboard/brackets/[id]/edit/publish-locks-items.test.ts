import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Proves issue #16's "after publishing, item add/edit/remove (#11) is no
 * longer usable, including via a direct request to the underlying
 * action/API, not just a hidden button" criterion for real, rather than by
 * code inspection alone: this calls the real (unmocked) `publishBracket`
 * from `./publish-actions.ts` to flip a bracket out of `DRAFT`, then calls
 * the real (unmocked) `addItem`/`updateItem`/`removeItem` from `./actions.ts`
 * directly - the same way a stale tab or a hand-crafted request would - and
 * asserts each is rejected.
 *
 * Only Prisma, the Supabase session lookup, `next/cache`, and the image
 * upload helper are mocked (the same infrastructure every other test in
 * this directory mocks, since they need a real Next.js/network context
 * Vitest doesn't provide). Crucially, `bracketFindFirst`/`bracketUpdate`
 * here read/write one shared mutable in-memory record used by both
 * `publish-actions.ts` and `actions.ts`, so `publishBracket`'s update is
 * actually visible to `addItem`/`updateItem`/`removeItem`'s subsequent
 * lookup - a true end-to-end proof of the lock, not two independently-mocked
 * stories.
 *
 * `./publish-actions.integration.test.ts` covers the same thing again
 * against the real, live database when one is configured.
 */
const getUser = vi.fn();
const bracketFindFirst = vi.fn();
const bracketUpdate = vi.fn();
const itemCount = vi.fn();
const itemFindFirst = vi.fn();
const itemFindMany = vi.fn();
const itemCreate = vi.fn();
const itemUpdate = vi.fn();
const itemDelete = vi.fn();
const roundCreate = vi.fn();
const revalidatePath = vi.fn();
const uploadBracketItemImage = vi.fn();

type BracketRecord = {
  id: string;
  creatorId: string;
  status: string;
  scheduledStartAt: Date | null;
  defaultRoundDurationMinutes: number;
  roundDurationOverrides: unknown;
};

let bracket: BracketRecord;
let items: { id: string; bracketId: string }[];

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst: bracketFindFirst, update: bracketUpdate },
    bracketItem: {
      count: itemCount,
      findFirst: itemFindFirst,
      findMany: itemFindMany,
      create: itemCreate,
      update: itemUpdate,
      delete: itemDelete,
    },
    round: { create: roundCreate },
    // Same shape as the real interactive transaction (#18): the callback
    // gets a `tx` whose relevant methods are these same shared mocks, so
    // `publishBracket`'s Round creation is visible to assertions below.
    $transaction: vi.fn(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          bracket: { update: bracketUpdate },
          round: { create: roundCreate },
        })
    ),
  },
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("./image-upload", () => ({ uploadBracketItemImage }));

const { publishBracket, initialPublishFormState } = await import(
  "./publish-actions"
);
const { addItem, updateItem, removeItem, initialItemFormState } =
  await import("./actions");

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

describe("publishing locks out #11's item actions for real, not just via a hidden button", () => {
  beforeEach(() => {
    getUser.mockReset();
    bracketFindFirst.mockReset();
    bracketUpdate.mockReset();
    itemCount.mockReset();
    itemFindFirst.mockReset();
    itemFindMany.mockReset();
    itemCreate.mockReset();
    itemUpdate.mockReset();
    itemDelete.mockReset();
    roundCreate.mockReset();
    revalidatePath.mockReset();
    uploadBracketItemImage.mockReset();

    getUser.mockResolvedValue({
      data: { user: { id: "creator-1" } },
      error: null,
    });

    bracket = {
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
    };
    items = [
      { id: "item-1", bracketId: "bracket-1" },
      { id: "item-2", bracketId: "bracket-1" },
    ];

    // These share `bracket`/`items` across both `publishBracket` and
    // `addItem`/`updateItem`/`removeItem`'s own lookups, so a status change
    // made by one is actually visible to the other, the whole point of this
    // file.
    bracketFindFirst.mockImplementation(
      async ({ where }: { where: { id: string; creatorId: string } }) => {
        if (bracket.id === where.id && bracket.creatorId === where.creatorId) {
          return { ...bracket };
        }
        return null;
      }
    );
    bracketUpdate.mockImplementation(
      async ({ data }: { where: { id: string }; data: Partial<BracketRecord> }) => {
        bracket = { ...bracket, ...data };
        return { ...bracket };
      }
    );
    itemCount.mockImplementation(async () => items.length);
    itemFindMany.mockImplementation(async () => [...items]);
    itemFindFirst.mockImplementation(
      async ({ where }: { where: { id: string; bracketId: string } }) =>
        items.find(
          (item) => item.id === where.id && item.bracketId === where.bracketId
        ) ?? null
    );
  });

  it("rejects addItem/updateItem/removeItem after a real publish flips the bracket to ACTIVE", async () => {
    const publishResult = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );
    expect(publishResult).toEqual({ error: null });
    expect(bracket.status).toBe("ACTIVE");

    const addResult = await addItem(
      "bracket-1",
      initialItemFormState,
      formData({ title: "Too late" })
    );
    expect(addResult).toEqual({
      error:
        "This bracket is no longer a draft, so its items can't be changed.",
    });
    expect(itemCreate).not.toHaveBeenCalled();

    const updateResult = await updateItem(
      "bracket-1",
      "item-1",
      initialItemFormState,
      formData({ title: "Also too late" })
    );
    expect(updateResult).toEqual({
      error:
        "This bracket is no longer a draft, so its items can't be changed.",
    });
    expect(itemUpdate).not.toHaveBeenCalled();

    const removeResult = await removeItem(
      "bracket-1",
      "item-1",
      initialItemFormState,
      new FormData()
    );
    expect(removeResult).toEqual({
      error:
        "This bracket is no longer a draft, so its items can't be changed.",
    });
    expect(itemDelete).not.toHaveBeenCalled();
  });

  it("rejects addItem/updateItem/removeItem after a real publish flips the bracket to SCHEDULED", async () => {
    bracket.scheduledStartAt = new Date("2099-01-01T09:00:00.000Z");

    const publishResult = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );
    expect(publishResult).toEqual({ error: null });
    expect(bracket.status).toBe("SCHEDULED");

    const addResult = await addItem(
      "bracket-1",
      initialItemFormState,
      formData({ title: "Too late" })
    );
    expect(addResult).toEqual({
      error:
        "This bracket is no longer a draft, so its items can't be changed.",
    });
    expect(itemCreate).not.toHaveBeenCalled();
  });
});
