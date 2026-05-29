/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import AppError from "../app/error";
import GlobalError from "../app/global-error";

describe("app/error", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows runtime error copy and invokes reset on Retry", () => {
    const reset = vi.fn();
    render(<AppError error={new Error("test failure")} reset={reset} />);
    expect(screen.getByText("Runtime Error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("shows digest when present", () => {
    const err = new Error("x") as Error & { digest?: string };
    err.digest = "abc123";
    render(<AppError error={err} reset={() => {}} />);
    expect(screen.getByText(/Digest: abc123/)).toBeTruthy();
  });
});

describe("app/global-error", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders the bare application-error shell with a reload instruction", () => {
    // global-error is intentionally pure HTML with NO retry button / hooks:
    // Next.js 16 prerender of /_global-error crashes if client context is
    // needed (see web/CLAUDE.md "Production Build Constraint"). The shell only
    // shows a reload instruction; there is no interactive reset control.
    const reset = vi.fn();
    render(<GlobalError error={new Error("root")} reset={reset} />);
    expect(screen.getByText("Application Error")).toBeTruthy();
    expect(screen.getByText(/Reload the page/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("renders the error digest when present", () => {
    render(<GlobalError error={Object.assign(new Error("root"), { digest: "deadbeef" })} reset={vi.fn()} />);
    expect(screen.getByText(/Digest: deadbeef/)).toBeTruthy();
  });
});
