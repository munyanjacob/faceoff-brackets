import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/api/auth`, `@/lib/prisma`, and (for `POST`)
// `@/app/dashboard/brackets/[id]/edit/image-upload` are mocked so this
// suite can assert on the route's own orchestration - the auth gate, that
// the bracket lookup is scoped to `id AND creatorId` together (never `id`
// alone), that "doesn't exist" and "exists but not owned" both collapse to
// the same 404 body (spec §4.9), the items query's ordering, and (for
// `POST`) the same ownership -> DRAFT-status -> validation -> upload ->
// create pipeline `addItem` already uses - without a live database or a
// real Storage upload. `validateBracketItemForm` itself is *not* mocked
// (same as `../../../../dashboard/brackets/[id]/edit/actions.test.ts`) -
// these tests exercise the real validation rules. End-to-end behaviour
// against real seeded data (and a real image upload) is covered separately
// in `./route.integration.test.ts`.
const getAuthenticatedUserId = vi.fn();
const findFirst = vi.fn();
const findMany = vi.fn();
const create = vi.fn();
const uploadBracketItemImage = vi.fn();

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/auth")>();
  return { ...actual, getAuthenticatedUserId };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst },
    bracketItem: { findMany, create },
  },
}));
vi.mock("@/app/dashboard/brackets/[id]/edit/image-upload", () => ({
  uploadBracketItemImage,
}));

const { GET, POST, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function requestFor(bracketId: string, authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  headers.set("origin", ALLOWED_ORIGIN);
  return new Request(`http://localhost/brackets/${bracketId}/items`, {
    headers,
  });
}

function postRequestFor(
  bracketId: string,
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
  return new Request(`http://localhost/brackets/${bracketId}/items`, {
    method: "POST",
    headers,
    body: formData,
  });
}

function pngFile(name = "poster.png"): File {
  return new File([new Uint8Array(1024)], name, { type: "image/png" });
}

function paramsFor(bracketId: string) {
  return { params: Promise.resolve({ bracketId }) };
}

describe("GET /brackets/{bracketId}/items", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    findFirst.mockReset();
    findMany.mockReset();
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token, before ever looking the bracket up", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await GET(requestFor("bracket-1"), paramsFor("bracket-1"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("scopes the bracket lookup to id AND creatorId together, never id alone", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({ id: "bracket-1", creatorId: "creator-1" });
    findMany.mockResolvedValue([]);

    await GET(requestFor("bracket-1", "Bearer token"), paramsFor("bracket-1"));

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "creator-1" },
    });
  });

  it("returns 404 NOT_FOUND (never 403) when the bracket doesn't exist", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(null);

    const response = await GET(
      requestFor("missing", "Bearer token"),
      paramsFor("missing")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns the exact same 404 body when the bracket exists but belongs to a different creator (indistinguishable by design)", async () => {
    getAuthenticatedUserId.mockResolvedValue("someone-else");
    // The scoped findFirst() itself returns null for a bracket owned by a
    // different creator - this route never sees "exists but not mine" as a
    // distinct case, which is the whole point of scoping the query this way.
    findFirst.mockResolvedValue(null);

    const response = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
  });

  it("returns 200 with the bracket's items in creation order", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({ id: "bracket-1", creatorId: "creator-1" });
    const items = [
      {
        id: "item-1",
        bracketId: "bracket-1",
        title: "Item One",
        description: null,
        imageUrl: null,
        seed: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    findMany.mockResolvedValue(items);

    const response = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { bracketId: "bracket-1" },
      orderBy: { createdAt: "asc" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { ...items[0], createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("applies CORS headers on the 401, 404, and 200 paths", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    const unauthorized = await GET(
      requestFor("bracket-1"),
      paramsFor("bracket-1")
    );
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(null);
    const notFound = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    findFirst.mockResolvedValue({ id: "bracket-1", creatorId: "creator-1" });
    findMany.mockResolvedValue([]);
    const ok = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("returns a generic 500 when the items query fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({ id: "bracket-1", creatorId: "creator-1" });
    findMany.mockRejectedValue(new Error("connection refused"));

    const response = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleError.mockRestore();
  });
});

describe("POST /brackets/{bracketId}/items", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    findFirst.mockReset();
    create.mockReset();
    uploadBracketItemImage.mockReset();
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token, before ever looking the bracket up", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await POST(
      postRequestFor("bracket-1", { title: "Die Hard" }),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND (never 403) when the bracket doesn't exist", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(null);

    const response = await POST(
      postRequestFor("missing", { title: "Die Hard" }, "Bearer token"),
      paramsFor("missing")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the exact same 404 body when the bracket exists but belongs to a different creator (indistinguishable by design)", async () => {
    getAuthenticatedUserId.mockResolvedValue("someone-else");
    findFirst.mockResolvedValue(null);

    const response = await POST(
      postRequestFor("bracket-1", { title: "Die Hard" }, "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
  });

  it("returns 409 NOT_DRAFT with the exact existing message when the bracket is no longer a draft", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "ACTIVE",
    });

    const response = await POST(
      postRequestFor("bracket-1", { title: "Die Hard" }, "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_DRAFT",
      message:
        "This bracket is no longer a draft, so its items can't be changed.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR with validateBracketItemForm's exact string when the title is missing", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });

    const response = await POST(
      postRequestFor("bracket-1", { description: "no title" }, "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Title is required.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR with the exact string for a non-PNG/JPEG/WebP image", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    const invalidImage = new File([new Uint8Array(10)], "notes.txt", {
      type: "text/plain",
    });

    const response = await POST(
      postRequestFor(
        "bracket-1",
        { title: "Die Hard", image: invalidImage },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Image must be a PNG, JPEG, or WebP file.",
    });
    expect(uploadBracketItemImage).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR with the exact string for an oversized image", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    const oversized = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      "big.png",
      { type: "image/png" }
    );

    const response = await POST(
      postRequestFor(
        "bracket-1",
        { title: "Die Hard", image: oversized },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Image must be 5MB or smaller.",
    });
    expect(uploadBracketItemImage).not.toHaveBeenCalled();
  });

  it("creates the item and returns 201 with the created BracketItem when there's no image", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    const created = {
      id: "item-1",
      bracketId: "bracket-1",
      title: "Die Hard",
      description: "A Christmas movie.",
      imageUrl: null,
      seed: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    create.mockResolvedValue(created);

    const response = await POST(
      postRequestFor(
        "bracket-1",
        { title: "Die Hard", description: "A Christmas movie." },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        bracketId: "bracket-1",
        title: "Die Hard",
        description: "A Christmas movie.",
        imageUrl: null,
      },
    });
    expect(uploadBracketItemImage).not.toHaveBeenCalled();
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ...created,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("uploads a valid image and saves its public URL as imageUrl", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    uploadBracketItemImage.mockResolvedValue(
      "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/poster.png"
    );
    create.mockResolvedValue({ id: "item-1" });
    const image = pngFile();

    await POST(
      postRequestFor("bracket-1", { title: "Die Hard", image }, "Bearer token"),
      paramsFor("bracket-1")
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
    expect(create).toHaveBeenCalledWith({
      data: {
        bracketId: "bracket-1",
        title: "Die Hard",
        description: null,
        imageUrl:
          "https://example.supabase.co/storage/v1/object/public/bracket-item-images/bracket-1/poster.png",
      },
    });
  });

  it("returns 502 IMAGE_UPLOAD_FAILED and creates no row when the image upload fails", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    uploadBracketItemImage.mockRejectedValue(new Error("network error"));

    const response = await POST(
      postRequestFor(
        "bracket-1",
        { title: "Die Hard", image: pngFile() },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      code: "IMAGE_UPLOAD_FAILED",
      message: "Failed to upload the image. Please try again.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("applies CORS headers on the 401, 404, 409, 400, and 201 paths", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    const unauthorized = await POST(
      postRequestFor("bracket-1", { title: "Die Hard" }),
      paramsFor("bracket-1")
    );
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(null);
    const notFound = await POST(
      postRequestFor("bracket-1", { title: "Die Hard" }, "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "ACTIVE",
    });
    const notDraft = await POST(
      postRequestFor("bracket-1", { title: "Die Hard" }, "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(notDraft.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    const invalid = await POST(
      postRequestFor("bracket-1", {}, "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(invalid.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    create.mockResolvedValue({ id: "item-1" });
    const created = await POST(
      postRequestFor("bracket-1", { title: "Die Hard" }, "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("returns a generic 500 when item creation fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    create.mockRejectedValue(new Error("connection refused"));

    const response = await POST(
      postRequestFor("bracket-1", { title: "Die Hard" }, "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleError.mockRestore();
  });
});

describe("OPTIONS /brackets/{bracketId}/items", () => {
  it("returns a 204 preflight response with CORS headers", () => {
    const response = OPTIONS(requestFor("bracket-1"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});
