import { describe, expect, it, vi } from "vitest";
import GlobalErrorBoundary from "./error";

/**
 * `./error.tsx` is this app's root `error.js` boundary (issue #36) - see
 * that file's top comment. Called directly as a plain function (the same
 * "introspect via JSON.stringify" pattern this codebase's other
 * presentational components use, e.g. `./dashboard/bracket-list.test.tsx`)
 * rather than actually mounted, since this codebase has no client-component
 * rendering tests anywhere else either.
 */
describe("root error boundary (issue #36)", () => {
  it("shows a clear, user-facing message instead of an unhandled exception or blank page", () => {
    const retry = vi.fn();
    const element = GlobalErrorBoundary({
      error: Object.assign(new Error("connection reset"), { digest: "abc" }),
      retry,
    });

    const html = JSON.stringify(element);
    expect(html).toContain("Something went wrong");
    expect(html.toLowerCase()).not.toContain("connection reset");
  });

  it("offers a way to retry that calls the retry() prop", () => {
    const retry = vi.fn();
    const element = GlobalErrorBoundary({
      error: Object.assign(new Error("connection reset"), { digest: "abc" }),
      retry,
    });

    // The "Try again" button is the last child of the <main>.
    const button = (
      element.props.children[2] as { props: { onClick: () => void } }
    );
    button.props.onClick();

    expect(retry).toHaveBeenCalledOnce();
  });
});
