import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const bracketFindFirst = vi.fn();
const itemFindFirst = vi.fn();
const itemCreate = vi.fn();
const itemUpdate = vi.fn();
const itemDelete = vi.fn();
const revalidatePath = vi.fn();
const uploadBracketItemImage = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst: bracketFindFirst },
    bracketItem: {
      findFirst: itemFindFirst,
      create: itemCreate,
      update: itemUpdate,
      delete: itemDelete,
    },
  },
}));

// `revalidatePath` needs a real Next.js request scope ("static generation
// store") that Vitest doesn't provide, and throws "Invariant: static
// generation store missing" without one - mocked for the same reason
// `@/lib/supabase/server` is mocked above (its `cookies()` call needs a
// real request scope too).
vi.mock("next/cache", () => ({ revalidatePath }));

// `./image-upload.ts` talks to real Supabase Storage - mocked here the same
// way `@/lib/prisma` is, so these tests exercise `./actions.ts`'s own logic
// (validation wiring, when to upload, how the result is saved) without any
// real network call. `./actions.integration.test.ts` covers the real,
// unmocked upload against the live Supabase project.
vi.mock("./image-upload", () => ({ uploadBracketItemImage }));

const { addItem, updateItem, removeItem, initialItemFormState } =
  await import("./actions");

function formData(fields: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

function pngFile(name = "poster.png"): File {
  return new File([new Uint8Array(1024)], name, { type: "image/png" });
}

function expect404(thrown: unknown) {
  expect(thrown).toBeDefined();
  expect((thrown as { digest?: string }).digest).toContain("404");
}

describe("BracketItem Server Actions", () => {
  beforeEach(() => {
    getUser.mockReset();
    bracketFindFirst.mockReset();
    itemFindFirst.mockReset();
    itemCreate.mockReset();
    itemUpdate.mockReset();
    itemDelete.mockReset();
    revalidatePath.mockReset();
    uploadBracketItemImage.mockReset();

    getUser.mockResolvedValue({
      data: { user: { id: "creator-1" } },
      error: null,
    });
  });

  describe("addItem", () => {
    it("creates a BracketItem scoped to the owned, draft bracket", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });

      const result = await addItem(
        "bracket-1",
        initialItemFormState,
        formData({ title: "Die Hard", description: "A Christmas movie." })
      );

      expect(bracketFindFirst).toHaveBeenCalledWith({
        where: { id: "bracket-1", creatorId: "creator-1" },
      });
      expect(itemCreate).toHaveBeenCalledWith({
        data: {
          bracketId: "bracket-1",
          title: "Die Hard",
          description: "A Christmas movie.",
          imageUrl: null,
        },
      });
      expect(uploadBracketItemImage).not.toHaveBeenCalled();
      expect(revalidatePath).toHaveBeenCalledWith(
        "/dashboard/brackets/bracket-1/edit"
      );
      expect(result).toEqual({ error: null });
    });

    it("uploads a valid image and saves its public URL as image_url (issue #12)", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      uploadBracketItemImage.mockResolvedValue(
        "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/poster.png"
      );
      const image = pngFile();

      const result = await addItem(
        "bracket-1",
        initialItemFormState,
        formData({ title: "Die Hard", image })
      );

      expect(uploadBracketItemImage).toHaveBeenCalledWith("bracket-1", image);
      expect(itemCreate).toHaveBeenCalledWith({
        data: {
          bracketId: "bracket-1",
          title: "Die Hard",
          description: null,
          imageUrl:
            "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/poster.png",
        },
      });
      expect(result).toEqual({ error: null });
    });

    it("returns an error and creates no row when the image upload fails", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      uploadBracketItemImage.mockRejectedValue(new Error("network error"));

      const result = await addItem(
        "bracket-1",
        initialItemFormState,
        formData({ title: "Die Hard", image: pngFile() })
      );

      expect(result).toEqual({
        error: "Failed to upload the image. Please try again.",
      });
      expect(itemCreate).not.toHaveBeenCalled();
    });

    it("returns a validation error and creates no row, and never uploads, when the image is invalid", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      const invalidImage = new File([new Uint8Array(1024)], "notes.txt", {
        type: "text/plain",
      });

      const result = await addItem(
        "bracket-1",
        initialItemFormState,
        formData({ title: "Die Hard", image: invalidImage })
      );

      expect(result).toEqual({
        error: "Image must be a PNG, JPEG, or WebP file.",
      });
      expect(uploadBracketItemImage).not.toHaveBeenCalled();
      expect(itemCreate).not.toHaveBeenCalled();
    });

    it("returns a validation error and creates no row when the title is missing", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });

      const result = await addItem(
        "bracket-1",
        initialItemFormState,
        formData({ description: "A Christmas movie." })
      );

      expect(result).toEqual({ error: "Title is required." });
      expect(itemCreate).not.toHaveBeenCalled();
    });

    it("returns a validation error and creates no row when the title is whitespace-only", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });

      const result = await addItem(
        "bracket-1",
        initialItemFormState,
        formData({ title: "   " })
      );

      expect(result).toEqual({ error: "Title is required." });
      expect(itemCreate).not.toHaveBeenCalled();
    });

    it("404s instead of adding an item to a bracket that isn't the signed-in creator's", async () => {
      bracketFindFirst.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await addItem(
          "someone-elses-bracket",
          initialItemFormState,
          formData({ title: "Die Hard" })
        );
      } catch (err) {
        thrown = err;
      }

      expect404(thrown);
      expect(itemCreate).not.toHaveBeenCalled();
    });

    it("returns an error and creates no row when the bracket is no longer a draft", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "ACTIVE",
      });

      const result = await addItem(
        "bracket-1",
        initialItemFormState,
        formData({ title: "Die Hard" })
      );

      expect(result).toEqual({
        error: "This bracket is no longer a draft, so its items can't be changed.",
      });
      expect(itemCreate).not.toHaveBeenCalled();
    });

    it("404s instead of adding an item when there is no signed-in user", async () => {
      getUser.mockResolvedValue({ data: { user: null }, error: null });

      let thrown: unknown;
      try {
        await addItem(
          "bracket-1",
          initialItemFormState,
          formData({ title: "Die Hard" })
        );
      } catch (err) {
        thrown = err;
      }

      expect404(thrown);
      expect(itemCreate).not.toHaveBeenCalled();
    });
  });

  describe("updateItem", () => {
    it("updates a BracketItem scoped to the owned, draft bracket", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      itemFindFirst.mockResolvedValue({ id: "item-1", bracketId: "bracket-1" });

      const result = await updateItem(
        "bracket-1",
        "item-1",
        initialItemFormState,
        formData({ title: "Die Hard 2", description: "Still Christmas." })
      );

      expect(itemFindFirst).toHaveBeenCalledWith({
        where: { id: "item-1", bracketId: "bracket-1" },
      });
      expect(itemUpdate).toHaveBeenCalledWith({
        where: { id: "item-1" },
        data: { title: "Die Hard 2", description: "Still Christmas." },
      });
      expect(uploadBracketItemImage).not.toHaveBeenCalled();
      expect(revalidatePath).toHaveBeenCalledWith(
        "/dashboard/brackets/bracket-1/edit"
      );
      expect(result).toEqual({ error: null });
    });

    it("uploads a new image and updates image_url to the new file's URL (issue #12)", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      itemFindFirst.mockResolvedValue({ id: "item-1", bracketId: "bracket-1" });
      uploadBracketItemImage.mockResolvedValue(
        "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/new-poster.png"
      );
      const image = pngFile("new-poster.png");

      const result = await updateItem(
        "bracket-1",
        "item-1",
        initialItemFormState,
        formData({ title: "Die Hard 2", image })
      );

      expect(uploadBracketItemImage).toHaveBeenCalledWith("bracket-1", image);
      expect(itemUpdate).toHaveBeenCalledWith({
        where: { id: "item-1" },
        data: {
          title: "Die Hard 2",
          description: null,
          imageUrl:
            "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/new-poster.png",
        },
      });
      expect(result).toEqual({ error: null });
    });

    it("leaves image_url untouched when no new image is chosen while editing", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      itemFindFirst.mockResolvedValue({
        id: "item-1",
        bracketId: "bracket-1",
        imageUrl: "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/existing.png",
      });

      const result = await updateItem(
        "bracket-1",
        "item-1",
        initialItemFormState,
        formData({ title: "Die Hard 2" })
      );

      expect(uploadBracketItemImage).not.toHaveBeenCalled();
      const updateCallData = itemUpdate.mock.calls[0][0].data;
      expect(updateCallData).not.toHaveProperty("imageUrl");
      expect(result).toEqual({ error: null });
    });

    it("returns an error and updates no row when replacing the image fails to upload", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      itemFindFirst.mockResolvedValue({ id: "item-1", bracketId: "bracket-1" });
      uploadBracketItemImage.mockRejectedValue(new Error("network error"));

      const result = await updateItem(
        "bracket-1",
        "item-1",
        initialItemFormState,
        formData({ title: "Die Hard 2", image: pngFile() })
      );

      expect(result).toEqual({
        error: "Failed to upload the image. Please try again.",
      });
      expect(itemUpdate).not.toHaveBeenCalled();
    });

    it("returns a validation error and updates no row when the replacement image is too large", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      itemFindFirst.mockResolvedValue({ id: "item-1", bracketId: "bracket-1" });
      const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", {
        type: "image/png",
      });

      const result = await updateItem(
        "bracket-1",
        "item-1",
        initialItemFormState,
        formData({ title: "Die Hard 2", image: oversized })
      );

      expect(result).toEqual({ error: "Image must be 5MB or smaller." });
      expect(uploadBracketItemImage).not.toHaveBeenCalled();
      expect(itemUpdate).not.toHaveBeenCalled();
    });

    it("returns a validation error and updates no row when the title is missing", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      itemFindFirst.mockResolvedValue({ id: "item-1", bracketId: "bracket-1" });

      const result = await updateItem(
        "bracket-1",
        "item-1",
        initialItemFormState,
        formData({ title: "   " })
      );

      expect(result).toEqual({ error: "Title is required." });
      expect(itemUpdate).not.toHaveBeenCalled();
    });

    it("404s instead of updating an item that belongs to a different bracket", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      itemFindFirst.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await updateItem(
          "bracket-1",
          "item-from-another-bracket",
          initialItemFormState,
          formData({ title: "Die Hard 2" })
        );
      } catch (err) {
        thrown = err;
      }

      expect404(thrown);
      expect(itemUpdate).not.toHaveBeenCalled();
    });

    it("404s instead of updating an item on a bracket that isn't the signed-in creator's", async () => {
      bracketFindFirst.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await updateItem(
          "someone-elses-bracket",
          "item-1",
          initialItemFormState,
          formData({ title: "Die Hard 2" })
        );
      } catch (err) {
        thrown = err;
      }

      expect404(thrown);
      expect(itemFindFirst).not.toHaveBeenCalled();
      expect(itemUpdate).not.toHaveBeenCalled();
    });

    it("returns an error and updates no row when the bracket is no longer a draft", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "SCHEDULED",
      });

      const result = await updateItem(
        "bracket-1",
        "item-1",
        initialItemFormState,
        formData({ title: "Die Hard 2" })
      );

      expect(result).toEqual({
        error: "This bracket is no longer a draft, so its items can't be changed.",
      });
      expect(itemFindFirst).not.toHaveBeenCalled();
      expect(itemUpdate).not.toHaveBeenCalled();
    });
  });

  describe("removeItem", () => {
    it("deletes a BracketItem scoped to the owned, draft bracket", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      itemFindFirst.mockResolvedValue({ id: "item-1", bracketId: "bracket-1" });

      const result = await removeItem(
        "bracket-1",
        "item-1",
        initialItemFormState,
        formData({})
      );

      expect(itemFindFirst).toHaveBeenCalledWith({
        where: { id: "item-1", bracketId: "bracket-1" },
      });
      expect(itemDelete).toHaveBeenCalledWith({ where: { id: "item-1" } });
      expect(revalidatePath).toHaveBeenCalledWith(
        "/dashboard/brackets/bracket-1/edit"
      );
      expect(result).toEqual({ error: null });
    });

    it("404s instead of removing an item that belongs to a different bracket", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "DRAFT",
      });
      itemFindFirst.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await removeItem(
          "bracket-1",
          "item-from-another-bracket",
          initialItemFormState,
          formData({})
        );
      } catch (err) {
        thrown = err;
      }

      expect404(thrown);
      expect(itemDelete).not.toHaveBeenCalled();
    });

    it("404s instead of removing an item on a bracket that isn't the signed-in creator's", async () => {
      bracketFindFirst.mockResolvedValue(null);

      let thrown: unknown;
      try {
        await removeItem(
          "someone-elses-bracket",
          "item-1",
          initialItemFormState,
          formData({})
        );
      } catch (err) {
        thrown = err;
      }

      expect404(thrown);
      expect(itemDelete).not.toHaveBeenCalled();
    });

    it("returns an error and deletes no row when the bracket is no longer a draft", async () => {
      bracketFindFirst.mockResolvedValue({
        id: "bracket-1",
        creatorId: "creator-1",
        status: "COMPLETED",
      });

      const result = await removeItem(
        "bracket-1",
        "item-1",
        initialItemFormState,
        formData({})
      );

      expect(result).toEqual({
        error: "This bracket is no longer a draft, so its items can't be changed.",
      });
      expect(itemFindFirst).not.toHaveBeenCalled();
      expect(itemDelete).not.toHaveBeenCalled();
    });
  });
});
