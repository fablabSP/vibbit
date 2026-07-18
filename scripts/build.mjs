import { mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const sourcePath = path.join(root, "work.js");
const manifestPath = path.join(root, "extension", "manifest.json");
const iconsSourceDir = path.join(root, "extension", "icons");
const frogSvgPath = path.join(iconsSourceDir, "vibbit-frog.svg");
const frogDataUriToken = "__VIBBIT_FROG_MARK_DATA_URI__";
const byokHostPermissions = [
  "https://api.openai.com/*",
  "https://generativelanguage.googleapis.com/*",
  "https://openrouter.ai/*"
];

const makecodeHostPermissions = [
  "https://makecode.microbit.org/*",
  "https://arcade.makecode.com/*",
  "https://maker.makecode.com/*"
];

const userscriptHeaderPattern = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/;

function overrideConst(source, name, value) {
  const stringPattern = new RegExp(`const ${name} = ".*?";`);
  const boolPattern = new RegExp(`const ${name} = (?:true|false);`);
  if (stringPattern.test(source)) {
    return source.replace(stringPattern, `const ${name} = ${JSON.stringify(value)};`);
  }
  if (boolPattern.test(source)) {
    return source.replace(boolPattern, `const ${name} = ${value === true ? "true" : "false"};`);
  }
  throw new Error(`Could not find ${name} declaration in work.js`);
}

function hostPermissionForBackend(backend) {
  const parsed = new URL(backend);
  return `${parsed.protocol}//${parsed.host}/*`;
}

function svgToDataUri(svgMarkup) {
  return `data:image/svg+xml,${encodeURIComponent(svgMarkup.replace(/\s+/g, " ").trim())}`;
}

async function build() {
  const [rawClient, rawManifest, frogSvgMarkup] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(frogSvgPath, "utf8")
  ]);

  let builtClient = rawClient.replace(userscriptHeaderPattern, "");
  const frogDataUri = svgToDataUri(frogSvgMarkup);
  builtClient = builtClient.replaceAll(frogDataUriToken, frogDataUri);
  const manifest = JSON.parse(rawManifest);

  const buildProfile = String(process.env.VIBBIT_BUILD_PROFILE || "").trim().toLowerCase();
  const hostedManagedProfile = buildProfile === "hosted-managed";
  let backend = process.env.VIBBIT_BACKEND;
  const appToken = process.env.VIBBIT_APP_TOKEN;

  if (hostedManagedProfile) {
    if (!backend || !/^https:\/\//i.test(String(backend).trim())) {
      throw new Error("VIBBIT_BUILD_PROFILE=hosted-managed requires VIBBIT_BACKEND to be an https URL");
    }
    if (appToken) {
      throw new Error("VIBBIT_BUILD_PROFILE=hosted-managed rejects VIBBIT_APP_TOKEN");
    }
    builtClient = overrideConst(builtClient, "HOSTED_MANAGED", true);
    backend = String(backend).trim();
  }

  if (backend) {
    builtClient = overrideConst(builtClient, "BACKEND", backend);
    const backendPermission = hostPermissionForBackend(backend);
    const optionalByokPermissions = hostedManagedProfile ? [] : byokHostPermissions;
    // Preserve MakeCode host permissions for toolbar-click flow
    manifest.host_permissions = [...new Set([...makecodeHostPermissions, backendPermission, ...optionalByokPermissions])];
  }

  if (!hostedManagedProfile && appToken !== undefined) {
    builtClient = overrideConst(builtClient, "APP_TOKEN", appToken);
  } else if (hostedManagedProfile) {
    builtClient = overrideConst(builtClient, "APP_TOKEN", "");
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  // Copy background.js
  const backgroundSrc = path.join(root, "extension", "background.js");
  await copyFile(backgroundSrc, path.join(distDir, "background.js"));

  // Copy icons
  const iconsDir = path.join(distDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  const iconFiles = await readdir(iconsSourceDir);
  await Promise.all(
    iconFiles.map(file =>
      copyFile(path.join(iconsSourceDir, file), path.join(iconsDir, file))
    )
  );

  await Promise.all([
    writeFile(path.join(distDir, "content-script.js"), builtClient, "utf8"),
    writeFile(path.join(distDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  ]);

  console.log("Built Chrome extension files in dist/");
  if (hostedManagedProfile) {
    console.log("- HOSTED_MANAGED enabled via VIBBIT_BUILD_PROFILE=hosted-managed");
  }
  if (backend) {
    console.log(`- BACKEND overridden via VIBBIT_BACKEND: ${backend}`);
    console.log(`- host_permissions: ${manifest.host_permissions.join(", ")}`);
  }
  if (appToken !== undefined) {
    console.log("- APP_TOKEN overridden via VIBBIT_APP_TOKEN");
  }
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
