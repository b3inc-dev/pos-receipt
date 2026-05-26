/**
 * .env / .env.migrate を process.env に読み込む（dotenv パッケージなし）
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadFile(filePath, { overrideEmpty = false } = {}) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const current = process.env[key];
    if (
      current === undefined ||
      (overrideEmpty && (current === "" || current === undefined))
    ) {
      process.env[key] = value;
    }
  }
}

loadFile(path.join(root, ".env"));
loadFile(path.join(root, ".env.migrate"), { overrideEmpty: true });
