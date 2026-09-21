import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/api/auth`, `@/lib/prisma`, and
// `@/app/dashboard/brackets/[id]/edit/image-upload` are mocked so this
// suite can assert on the route's own orchestration - the auth gate, the
// ownership -> DRAFT-status -> item-lookup order shared by `PATCH`/`DELETE`
// (mirroring `updateItem`/`removeItem` in
// `../../../../../dashboard/brackets/[id]/edit/actions.ts`), that
// "doesn't exist" and "exists but not owned" collapse to the same 404 body
// (spec §4.9), and (for `PATCH`) that omitting `image` never touches
// `imageUrl` - without a live database or a real Storage upload.
// `validateBracketItemForm` itself is *not* mocked (same as
// `../../../../../dashboard/brackets/[id]/edit/actions.test.ts`) - these
// tests exercise the real validation rules. End-to-end behaviour against
// real seeded data (and a real image upload) is covered separately in
// `./route.integration.test.ts`.
const getAuthenticatedUserId = vi.fn();
const bracketFindFirst = vi.fn();
const itemFindFirst = vi.fn();
const itemUpdate = vi.fn();
const itemDelete = vi.fn();
const uploadBracketItemImage = vi.fn();

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>();
  return { ...actual, getAuthenticatedUserId };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst: bracketFindFirst },
    bracketItem: {
      findFirst: itemFindFirst,
      update: itemUpdate,
      delete: itemDelete,
    },
  },
}));
vi.mock("@/app/dashboard/brackets/[id]/edit/image-upload", () => ({
  uploadBracketItemImage,
}));

const { PATCH, DELETE, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function url(bracketId: string, itemId: string) {
  return `http://localhost/brackets/${bracketId}/items/${itemId}`;
}

function patchRequestFor(
  bracketId: string,
  itemId: string,
  fields: Record<string, string | File>,
  authorization?: string
) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  headers.set("origin", ALLOWED_ORIGIN);
  return new Request(url(bracketId, itemId), {
    method: "PATCH",
    headers,
    body: formData,
  });
}

function deleteRequestFor(
  bracketId: string,
  itemId: string,
  authorization?: string
) {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  headers.set("origin", ALLOWED_ORIGIN);
  return new Request(url(bracketId, itemId), {
    method: "DELETE",
    headers,
  });
}

function pngFile(name = "poster.png"): File {
  return new File([new Uint8Array(1024)], name, { type: "image/png" });
}

function paramsFor(bracketId: string, itemId: string) {
  return { params: Promise.resolve({ bracketId, itemId }) };
}

const DRAFT_BRACKET = { id: "bracket-1", creatorId: "creator-1", status: "DRAFT" };
const ACTIVE_BRACKET = { id: "bracket-1", creatorId: "creator-1", status: "ACTIVE" };
const EXISTING_ITEM = {
  id: "item-1",
  bracketId: "bracket-1",
  title: "Die Hard",
  description: null,
  imageUrl:
    "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/existing.png",
};

describe("PATCH /brackets/{bracketId}/items/{itemId}", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    bracketFindFirst.mockReset();
    itemFindFirst.mockReset();
    itemUpdate.mockReset();
    uploadBracketItemImage.mockReset();
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token, before any lookup", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "New Title" }),
      paramsFor("bracket-1", "item-1")
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(bracketFindFirst).not.toHaveBeenCalled();
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND (never 403) when the bracket doesn't exist or isn't owned by the caller", async () => {
    getAuthenticatedUserId.mockResolvedValue("someone-else");
    bracketFindFirst.mockResolvedValue(null);

    const response = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "New Title" }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    expect(bracketFindFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "someone-else" },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
    expect(itemFindFirst).not.toHaveBeenCalled();
  });

  it("returns 409 NOT_DRAFT with the exact existing message when the bracket is no longer a draft", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(ACTIVE_BRACKET);

    const response = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "New Title" }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_DRAFT",
      message:
        "This bracket is no longer a draft, so its items can't be changed.",
    });
    expect(itemFindFirst).not.toHaveBeenCalled();
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the item doesn't exist, or belongs to a different bracket", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(null);

    const response = await PATCH(
      patchRequestFor("bracket-1", "item-from-elsewhere", { title: "New Title" }, "Bearer token"),
      paramsFor("bracket-1", "item-from-elsewhere")
    );

    expect(itemFindFirst).toHaveBeenCalledWith({
      where: { id: "item-from-elsewhere", bracketId: "bracket-1" },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This item no longer exists.",
    });
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR with the exact string when the title is missing", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);

    const response = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "   " }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Title is required.",
    });
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("updates title/description and returns 200 with the updated BracketItem", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    const updated = { ...EXISTING_ITEM, title: "Die Hard 2", description: "Still Christmas." };
    itemUpdate.mockResolvedValue(updated);

    const response = await PATCH(
      patchRequestFor(
        "bracket-1",
        "item-1",
        { title: "Die Hard 2", description: "Still Christmas." },
        "Bearer token"
      ),
      paramsFor("bracket-1", "item-1")
    );

    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { title: "Die Hard 2", description: "Still Christmas." },
    });
    expect(uploadBracketItemImage).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(updated);
  });

  it("preserves the item's existing imageUrl when PATCH omits the image field entirely (no accidental clear)", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    itemUpdate.mockResolvedValue(EXISTING_ITEM);

    await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "Die Hard 2" }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    expect(uploadBracketItemImage).not.toHaveBeenCalled();
    const updateCallData = itemUpdate.mock.calls[0][0].data;
    expect(updateCallData).not.toHaveProperty("imageUrl");
  });

  it("preserves the item's existing imageUrl when PATCH submits an empty/untouched file input", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    itemUpdate.mockResolvedValue(EXISTING_ITEM);
    const emptyFileInput = new File([], "", { type: "" });

    await PATCH(
      patchRequestFor(
        "bracket-1",
        "item-1",
        { title: "Die Hard 2", image: emptyFileInput },
        "Bearer token"
      ),
      paramsFor("bracket-1", "item-1")
    );

    expect(uploadBracketItemImage).not.toHaveBeenCalled();
    const updateCallData = itemUpdate.mock.calls[0][0].data;
    expect(updateCallData).not.toHaveProperty("imageUrl");
  });

  it("uploads a new image and saves its public URL as imageUrl when a valid file is submitted", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    uploadBracketItemImage.mockResolvedValue(
      "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/new-poster.png"
    );
    itemUpdate.mockResolvedValue({ ...EXISTING_ITEM });
    const image = pngFile("new-poster.png");

    await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "Die Hard 2", image }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    // Not `toHaveBeenCalledWith("bracket-1", image)`: the `File` reaching
    // the handler was reconstructed by `request.formData()`'s multipart
    // parsing, so it's a distinct (if content-identical) `File` instance
    // from `image` - only its own fields, not reference equality, are
    // meaningful here.
    expect(uploadBracketItemImage).toHaveBeenCalledTimes(1);
    const [uploadBracketId, uploadedFile] = uploadBracketItemImage.mock.calls[0];
    expect(uploadBracketId).toBe("bracket-1");
    expect(uploadedFile).toBeInstanceOf(File);
    expect(uploadedFile.name).toBe(image.name);
    expect(uploadedFile.type).toBe(image.type);
    expect(uploadedFile.size).toBe(image.size);
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: {
        title: "Die Hard 2",
        description: null,
        imageUrl:
          "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/new-poster.png",
      },
    });
  });

  it("returns 502 IMAGE_UPLOAD_FAILED and updates no row when the replacement image fails to upload", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    uploadBracketItemImage.mockRejectedValue(new Error("network error"));

    const response = await PATCH(
      patchRequestFor(
        "bracket-1",
        "item-1",
        { title: "Die Hard 2", image: pngFile() },
        "Bearer token"
      ),
      paramsFor("bracket-1", "item-1")
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      code: "IMAGE_UPLOAD_FAILED",
      message: "Failed to upload the image. Please try again.",
    });
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("applies CORS headers on the 401, 404, 409, 400, and 200 paths", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    const unauthorized = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "Die Hard 2" }),
      paramsFor("bracket-1", "item-1")
    );
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(null);
    const notFound = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "Die Hard 2" }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    bracketFindFirst.mockResolvedValue(ACTIVE_BRACKET);
    const notDraft = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "Die Hard 2" }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );
    expect(notDraft.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    const invalid = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "  " }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );
    expect(invalid.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    itemUpdate.mockResolvedValue(EXISTING_ITEM);
    const success = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "Die Hard 2" }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );
    expect(success.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("returns a generic 500 when the update fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    itemUpdate.mockRejectedValue(new Error("connection reset"));

    const response = await PATCH(
      patchRequestFor("bracket-1", "item-1", { title: "Die Hard 2" }, "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleError.mockRestore();
  });
});

describe("DELETE /brackets/{bracketId}/items/{itemId}", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    bracketFindFirst.mockReset();
    itemFindFirst.mockReset();
    itemDelete.mockReset();
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token, before any lookup", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await DELETE(
      deleteRequestFor("bracket-1", "item-1"),
      paramsFor("bracket-1", "item-1")
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(itemDelete).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND (never 403) when the bracket doesn't exist or isn't owned by the caller", async () => {
    getAuthenticatedUserId.mockResolvedValue("someone-else");
    bracketFindFirst.mockResolvedValue(null);

    const response = await DELETE(
      deleteRequestFor("bracket-1", "item-1", "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
    expect(itemDelete).not.toHaveBeenCalled();
  });

  it("returns 409 NOT_DRAFT with the exact existing message when the bracket is no longer a draft", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(ACTIVE_BRACKET);

    const response = await DELETE(
      deleteRequestFor("bracket-1", "item-1", "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_DRAFT",
      message:
        "This bracket is no longer a draft, so its items can't be changed.",
    });
    expect(itemFindFirst).not.toHaveBeenCalled();
    expect(itemDelete).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the item doesn't exist, or belongs to a different bracket", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(null);

    const response = await DELETE(
      deleteRequestFor("bracket-1", "item-from-elsewhere", "Bearer token"),
      paramsFor("bracket-1", "item-from-elsewhere")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This item no longer exists.",
    });
    expect(itemDelete).not.toHaveBeenCalled();
  });

  it("deletes the item and returns 204 with an empty body", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    itemDelete.mockResolvedValue(EXISTING_ITEM);

    const response = await DELETE(
      deleteRequestFor("bracket-1", "item-1", "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    expect(itemDelete).toHaveBeenCalledWith({ where: { id: "item-1" } });
    expect(response.status).toBe(204);
    const text = await response.text();
    expect(text).toBe("");
  });

  it("applies CORS headers on the 401, 404, 409, and 204 paths", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    const unauthorized = await DELETE(
      deleteRequestFor("bracket-1", "item-1"),
      paramsFor("bracket-1", "item-1")
    );
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(null);
    const notFound = await DELETE(
      deleteRequestFor("bracket-1", "item-1", "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    bracketFindFirst.mockResolvedValue(ACTIVE_BRACKET);
    const notDraft = await DELETE(
      deleteRequestFor("bracket-1", "item-1", "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );
    expect(notDraft.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    itemDelete.mockResolvedValue(EXISTING_ITEM);
    const success = await DELETE(
      deleteRequestFor("bracket-1", "item-1", "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );
    expect(success.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("returns a generic 500 when deletion fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(DRAFT_BRACKET);
    itemFindFirst.mockResolvedValue(EXISTING_ITEM);
    itemDelete.mockRejectedValue(new Error("connection reset"));

    const response = await DELETE(
      deleteRequestFor("bracket-1", "item-1", "Bearer token"),
      paramsFor("bracket-1", "item-1")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleError.mockRestore();
  });
});

describe("OPTIONS /brackets/{bracketId}/items/{itemId}", () => {
  it("returns a 204 preflight response with CORS headers", () => {
    const response = OPTIONS(deleteRequestFor("bracket-1", "item-1"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});
