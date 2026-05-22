import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runScript, resolveProjectRoot, resolvePythonBin, _resetRootCache } from "../runner";

describe("resolveProjectRoot", () => {
  beforeEach(() => _resetRootCache());

  it("returns a path containing scripts/ and data/", () => {
    const root = resolveProjectRoot();
    expect(root).toBeTruthy();
    expect(existsSync(join(root, "scripts"))).toBe(true);
    expect(existsSync(join(root, "data"))).toBe(true);
  });

  it("caches the result", () => {
    const first = resolveProjectRoot();
    const second = resolveProjectRoot();
    expect(first).toBe(second);
  });
});

describe("runScript", () => {
  it("returns ok: true with parsed JSON for a valid script", async () => {
    const result = await runScript("scripts/kelly.py", {
      args: ["--prob", "0.6", "--odds", "2.0"],
      timeout: 10_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("full_kelly_pct");
      expect(result.data).toHaveProperty("edge_exists");
      expect(result.data).toHaveProperty("recommendation");
    }
  });

  it("returns ok: false for a non-existent script", async () => {
    const result = await runScript("scripts/nonexistent.py");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr).toContain("not found");
    }
  });

  it("returns ok: false when script exits non-zero", async () => {
    // fetch_ticker exits 1 when ticker not verified — use a guaranteed-bad ticker
    const result = await runScript("scripts/kelly.py", {
      args: ["--prob", "not-a-number"],
      timeout: 10_000,
    });

    expect(result.ok).toBe(false);
  });

  it("supports rawOutput mode (no JSON parsing)", async () => {
    const result = await runScript("scripts/kelly.py", {
      args: ["--prob", "0.6", "--odds", "2.0"],
      rawOutput: true,
      timeout: 10_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // rawOutput returns the string, not parsed JSON
      expect(typeof result.data).toBe("string");
      expect((result.data as string)).toContain("full_kelly_pct");
    }
  });

  it("returns schema validation error when output doesn't match schema", async () => {
    const { Type } = await import("@sinclair/typebox");
    const WrongSchema = Type.Object({
      nonexistent_field: Type.String(),
    });

    const result = await runScript("scripts/kelly.py", {
      args: ["--prob", "0.6", "--odds", "2.0"],
      outputSchema: WrongSchema,
      timeout: 10_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr).toContain("Schema validation failed");
    }
  });
});

// Regression coverage for the 2026-05-22 production outage where
// /api/ticker/ratings returned 502 because `runScript` spawned bare
// `python3.13`, which on Hetzner is the system interpreter and lacks
// every Radon dep (dotenv, ib_insync, ...). The venv at <root>/.venv
// is the only Python with deps installed. `resolvePythonBin` must
// pick it up.
describe("resolvePythonBin", () => {
  let scratchRoot: string;

  beforeEach(() => {
    _resetRootCache();
    scratchRoot = join(tmpdir(), `radon-runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(scratchRoot, { recursive: true });
    delete process.env.RADON_PYTHON_BIN;
  });

  afterEach(() => {
    _resetRootCache();
    delete process.env.RADON_PYTHON_BIN;
    if (scratchRoot && existsSync(scratchRoot)) {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it("prefers <root>/.venv/bin/python3.13 when present", () => {
    const venvBin = join(scratchRoot, ".venv", "bin");
    mkdirSync(venvBin, { recursive: true });
    const candidate = join(venvBin, "python3.13");
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
    chmodSync(candidate, 0o755);

    expect(resolvePythonBin(scratchRoot)).toBe(candidate);
  });

  it("falls back to python3 in venv when 3.13 missing", () => {
    const venvBin = join(scratchRoot, ".venv", "bin");
    mkdirSync(venvBin, { recursive: true });
    const candidate = join(venvBin, "python3");
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
    chmodSync(candidate, 0o755);

    expect(resolvePythonBin(scratchRoot)).toBe(candidate);
  });

  it("falls back to 'python3.13' on PATH when no venv exists", () => {
    expect(resolvePythonBin(scratchRoot)).toBe("python3.13");
  });

  it("honors RADON_PYTHON_BIN env override when the file exists", () => {
    const override = join(scratchRoot, "custom-python");
    writeFileSync(override, "#!/bin/sh\nexit 0\n");
    chmodSync(override, 0o755);
    process.env.RADON_PYTHON_BIN = override;

    expect(resolvePythonBin(scratchRoot)).toBe(override);
  });

  it("ignores RADON_PYTHON_BIN when target file is missing", () => {
    process.env.RADON_PYTHON_BIN = "/nonexistent/python";

    expect(resolvePythonBin(scratchRoot)).toBe("python3.13");
  });
});

// Sanity test: the live repo root should resolve to a venv when one
// exists (laptop dev or production), and to "python3.13" otherwise.
// Either result is acceptable; the test asserts the returned value is
// at least executable-or-on-PATH-looking.
describe("resolvePythonBin (live tree)", () => {
  beforeEach(() => _resetRootCache());

  it("returns either an absolute venv path or the bare interpreter name", () => {
    const bin = resolvePythonBin(resolveProjectRoot());
    if (bin.startsWith("/")) {
      expect(existsSync(bin)).toBe(true);
    } else {
      expect(bin).toBe("python3.13");
    }
  });
});
