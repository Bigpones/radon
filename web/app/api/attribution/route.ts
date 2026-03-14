import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { join } from "path";

export const runtime = "nodejs";

const SCRIPTS_DIR = join(process.cwd(), "..", "scripts");
const PYTHON_BIN = process.env.PYTHON_BIN ?? "/usr/bin/python3";

function runAttribution(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, ["portfolio_attribution.py", "--json"], {
      cwd: SCRIPTS_DIR,
      env: { ...process.env },
      timeout: 15_000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`attribution script exited ${code}: ${stderr}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

export async function GET() {
  try {
    const raw = await runAttribution();
    const jsonStart = raw.indexOf("{");
    if (jsonStart === -1) {
      return NextResponse.json({ error: "No JSON output from attribution script" }, { status: 500 });
    }
    const data = JSON.parse(raw.slice(jsonStart));
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
