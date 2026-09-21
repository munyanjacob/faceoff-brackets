import { expect, test } from "vitest";
import { APP_NAME } from "./constants";

test("APP_NAME is set", () => {
  expect(APP_NAME).toBe("ai-dev-tools-experiment");
});
