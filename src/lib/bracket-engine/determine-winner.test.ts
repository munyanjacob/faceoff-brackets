import { describe, expect, test } from "vitest";
import { determineWinner } from "./determine-winner";

describe("determineWinner", () => {
  test("A wins with strictly more votes", () => {
    expect(determineWinner(10, 3)).toBe("A");
  });

  test("B wins with strictly more votes", () => {
    expect(determineWinner(2, 7)).toBe("B");
  });

  test("exact tie with votes on both sides is a TIE", () => {
    expect(determineWinner(5, 5)).toBe("TIE");
  });

  test("zero votes on both sides is treated as a TIE", () => {
    expect(determineWinner(0, 0)).toBe("TIE");
  });
});
