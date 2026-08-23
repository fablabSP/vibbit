import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_COMPAT_EXPORT_NAMES } from "../shared/makecode-compat-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const sharedPath = path.join(root, "shared", "makecode-compat-core.mjs");
const workPath = path.join(root, "work.js");
const checkOnly = process.argv.includes("--check");

const legacyStartToken = "  const sanitizeMakeCode = (input) => {";
const legacyEndToken = "  const parseModelList = (model) => {";
const markerStartToken = "  // BEGIN_SHARED_COMPAT_CORE";
const markerEndToken = "  // END_SHARED_COMPAT_CORE";

function stripExports(source) {
  let transformed = source
    .replace(/^export\s+async\s+function\s+/gm, "async function ")
    .replace(/^export\s+(const|function)\s+/gm, "$1 ")
    .replace(/^export\s+\{[\s\S]*?\};?\s*$/gm, "")
    .trim();
  transformed = transformed.replace(/const SHARED_COMPAT_EXPORT_NAMES = \[[\s\S]*?\];\n*/m, "");
  if (/^export\b/m.test(transformed)) {
    throw new Error("Compat core still contains export after strip. Update stripExports().");
  }
  return transformed.trim();
}

function indentLines(text, spaces) {
  const prefix = " ".repeat(spaces);
  return text.split("\n").map((line) => (line ? prefix + line : "")).join("\n");
}

function buildGeneratedBlock(sharedSource) {
  const exportList = SHARED_COMPAT_EXPORT_NAMES;
  return [
    "  /* ── shared compat core (generated) ───────────────────── */",
    "  // BEGIN_SHARED_COMPAT_CORE",
    "  const {",
    ...exportList.map((name) => `    ${name},`),
    "  } = (() => {",
    indentLines(stripExports(sharedSource), 4),
    "",
    "    return {",
    ...exportList.map((name) => `      ${name},`),
    "    };",
    "  })();",
    "  // END_SHARED_COMPAT_CORE"
  ].join("\n");
}

async function main() {
  const [sharedSource, workSource] = await Promise.all([
    readFile(sharedPath, "utf8"),
    readFile(workPath, "utf8")
  ]);

  let start = -1;
  let end = -1;

  const markerStart = workSource.indexOf(markerStartToken);
  const markerEnd = workSource.indexOf(markerEndToken);
  if (markerStart !== -1 && markerEnd !== -1 && markerEnd > markerStart) {
    const generatedComment = "  /* ── shared compat core (generated)";
    const commentStart = workSource.lastIndexOf(generatedComment, markerStart);
    start = commentStart !== -1 ? commentStart : markerStart;
    end = markerEnd + markerEndToken.length;
  } else {
    const legacyStart = workSource.indexOf(legacyStartToken);
    const legacyEnd = workSource.indexOf(legacyEndToken);
    if (legacyStart !== -1 && legacyEnd !== -1 && legacyEnd > legacyStart) {
      start = legacyStart;
      end = legacyEnd;
    }
  }

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not locate compat helper block boundaries in work.js.");
  }

  const generatedBlock = buildGeneratedBlock(sharedSource);
  const suffix = workSource.slice(end);
  const separator = suffix.startsWith("\n\n") ? "" : "\n\n";
  const nextWorkSource = workSource.slice(0, start) + generatedBlock + separator + suffix;

  if (nextWorkSource === workSource) {
    console.log("Compat core block is already in sync.");
    return;
  }

  if (checkOnly) {
    throw new Error("Compat core block is out of sync. Run: npm run sync:compat-core");
  }

  await writeFile(workPath, nextWorkSource, "utf8");
  console.log("Updated generated compat core block in work.js.");
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
