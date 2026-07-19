import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  assertFileExists,
  buildMarkdownTable,
  createAuditRunDir,
  repoRoot,
  runCommand,
  trimForTable,
  writeText
} from "./utils.mjs";

const runDir = await createAuditRunDir("smoke");
const screenshots = {
  makecode: path.join(runDir, "01-makecode-page.png"),
  panel: path.join(runDir, "02-panel-visible.png"),
  managed: path.join(runDir, "03-managed-mode.png"),
  byok: path.join(runDir, "04-byok-mode.png"),
  managedFeedback: path.join(runDir, "05-managed-feedback.png"),
  byokFeedback: path.join(runDir, "06-byok-feedback.png"),
  hostedPanel: path.join(runDir, "07-hosted-panel.png"),
  error: path.join(runDir, "99-error.png")
};

const checks = [];
let overallPass = true;

function pushCheck(step, pass, detail) {
  checks.push({ step, result: pass ? "PASS" : "FAIL", detail: trimForTable(detail) });
  if (!pass) overallPass = false;
}

async function installFetchMock(page) {
  await page.evaluate(() => {
    if (!window.__smokeMonacoStub) {
      const model = {
        __value: "",
        getValue() {
          return this.__value;
        },
        setValue(next) {
          this.__value = String(next || "");
          window.__smokeMonacoValue = this.__value;
        }
      };
      const editor = {
        getModel() {
          return model;
        },
        setPosition() {}
      };
      window.monaco = {
        editor: {
          getModels() {
            return [model];
          },
          getEditors() {
            return [editor];
          }
        }
      };
      for (const label of ["JavaScript", "Blocks"]) {
        const existing = [...document.querySelectorAll("button,[role='tab']")]
          .find((node) => ((node.textContent || "") + " " + (node.getAttribute("aria-label") || "")).includes(label));
        if (existing) continue;
        const tab = document.createElement("button");
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-label", label);
        tab.textContent = label;
        tab.style.position = "fixed";
        tab.style.left = "-9999px";
        document.body.appendChild(tab);
      }
      window.__smokeMonacoStub = true;
    }

    if (!window.__smokeFetchMock) {
      const nativeFetch = window.fetch.bind(window);
      window.__smokeManagedCalls = 0;
      window.__smokeByokCalls = 0;
      window.__smokeConnectCalls = 0;
      window.__smokeSessionToken = "";
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
        const headers = (init && init.headers) || {};
        const authHeader = typeof headers.get === "function"
          ? (headers.get("authorization") || headers.get("Authorization") || "")
          : (headers.Authorization || headers.authorization || "");
        if (url.includes("/vibbit/connect")) {
          window.__smokeConnectCalls += 1;
          window.__smokeSessionToken = "smoke-session-token";
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            classroomName: "Smoke Classroom",
            sessionToken: window.__smokeSessionToken,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }));
        }
        if (url.includes("/vibbit/generate")) {
          if (!window.__smokeSessionToken || !String(authHeader).includes(window.__smokeSessionToken)) {
            return Promise.resolve(new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" }
            }));
          }
          window.__smokeManagedCalls += 1;
          return Promise.resolve(new Response(JSON.stringify({
            code: "basic.showString(\"Managed\")",
            feedback: []
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }));
        }
        if (url.includes("api.openai.com/v1/chat/completions")) {
          window.__smokeByokCalls += 1;
          return Promise.resolve(new Response(JSON.stringify({
            choices: [{
              message: {
                content: [
                  "{\"meta\":\"ignored\"}",
                  "{\"feedback\":[],\"code\":\"basic.showString(\\\"BYOK\\\")\"}"
                ].join("\n")
              }
            }]
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }));
        }
        return nativeFetch(input, init);
      };
      window.__smokeFetchMock = true;
    }
  });
}

async function runBuildAndPackage() {
  await runCommand("npm", ["run", "check:compat-core"], { cwd: repoRoot });
  pushCheck("Compat core sync", true, "`npm run check:compat-core` passed.");

  await runCommand("npm", ["run", "build"], { cwd: repoRoot });
  const neutralManifest = JSON.parse(
    await readFile(path.join(repoRoot, "dist", "manifest.json"), "utf8")
  );
  const neutralScript = await readFile(path.join(repoRoot, "dist", "content-script.js"), "utf8");
  const neutralHasByokPerms = (neutralManifest.host_permissions || []).includes("https://api.openai.com/*")
    && (neutralManifest.host_permissions || []).includes("https://generativelanguage.googleapis.com/*")
    && (neutralManifest.host_permissions || []).includes("https://openrouter.ai/*");
  pushCheck(
    "Neutral build keeps BYOK host permissions",
    neutralHasByokPerms && /const HOSTED_MANAGED = false;/.test(neutralScript),
    `byokPerms=${neutralHasByokPerms}, hostedManagedFalse=${/const HOSTED_MANAGED = false;/.test(neutralScript)}.`
  );

  await runCommand("npm", ["run", "package"], { cwd: repoRoot });
  await assertFileExists(path.join(repoRoot, "dist", "content-script.js"));
  await assertFileExists(path.join(repoRoot, "dist", "manifest.json"));
  await assertFileExists(path.join(repoRoot, "artifacts", "vibbit-extension.zip"));

  const hostedManifest = JSON.parse(
    await readFile(path.join(repoRoot, "dist", "manifest.json"), "utf8")
  );
  const hostedScript = await readFile(path.join(repoRoot, "dist", "content-script.js"), "utf8");
  const hostedHasByokPerms = (hostedManifest.host_permissions || []).some((item) => (
    item.includes("api.openai.com")
    || item.includes("generativelanguage.googleapis.com")
    || item.includes("openrouter.ai")
  ));
  pushCheck(
    "Hosted package is code-only Managed",
    /const HOSTED_MANAGED = true;/.test(hostedScript)
      && /const BACKEND = "https:\/\/vibbit\.tk\.sg";/.test(hostedScript)
      && !hostedHasByokPerms
      && (hostedManifest.host_permissions || []).includes("https://vibbit.tk.sg/*"),
    `hostedManaged=${/const HOSTED_MANAGED = true;/.test(hostedScript)}, byokPermsRemoved=${!hostedHasByokPerms}.`
  );
  pushCheck("Build + package", true, "`npm run build` (neutral) and `npm run package` (hosted) succeeded.");
}

async function runNeutralUiSmoke(page) {
  const runtime = await readFile(path.join(repoRoot, "work.js"), "utf8");
  pushCheck(
    "02 Prompt format guard",
    !runtime.includes("FEEDBACK:"),
    "Runtime prompt no longer uses legacy FEEDBACK: prefix instructions."
  );
  pushCheck(
    "03 Prompt micro:bit guardrails",
    runtime.includes("MICRO:BIT BUILT-IN ICON/ENUM RULES")
      && runtime.includes("MICRO:BIT BLOCKS-TEST STYLE EXAMPLES"),
    "Runtime prompt keeps pxt-microbit icon/enum + blocks-test style guidance."
  );
  const sharedCompatCore = await readFile(path.join(repoRoot, "shared", "makecode-compat-core.mjs"), "utf8");
  pushCheck(
    "03b Backend prompt micro:bit guardrails",
    sharedCompatCore.includes("MICRO:BIT BUILT-IN ICON/ENUM RULES")
      && sharedCompatCore.includes("MICRO:BIT BLOCKS-TEST STYLE EXAMPLES"),
    "Backend prompt keeps pxt-microbit icon/enum + blocks-test style guidance."
  );

  await page.addScriptTag({ content: runtime });
  await page.waitForSelector("#vibbit-fab", { timeout: 20000 });
  await page.click("#vibbit-fab");
  await page.waitForSelector("#setup-go", { timeout: 20000 });
  await page.screenshot({ path: screenshots.panel, fullPage: false });

  const panelVisible = await page.evaluate(() => {
    const panel = document.querySelector("#vibbit-panel");
    const setupView = document.querySelector("#bv-setup");
    if (!panel || !setupView) return false;
    const panelRect = panel.getBoundingClientRect();
    const setupStyle = getComputedStyle(setupView);
    return panelRect.width > 0 && panelRect.height > 0 && setupStyle.display !== "none";
  });
  pushCheck(
    "04 Panel visible",
    panelVisible,
    panelVisible
      ? `Panel rendered and screenshot saved at \`${screenshots.panel}\`.`
      : "Panel controls were not visible after injecting `work.js`."
  );

  const setupDefault = await page.evaluate(() => {
    const mode = document.querySelector("#setup-mode");
    const modeRow = document.querySelector("#setup-mode-row");
    const byokProvider = document.querySelector("#setup-byok-provider");
    const byokModel = document.querySelector("#setup-byok-model");
    const byokKey = document.querySelector("#setup-byok-key");
    const managedServer = document.querySelector("#setup-managed-server");
    return {
      modeValue: mode ? mode.value : "",
      modeRowHidden: modeRow ? getComputedStyle(modeRow).display === "none" : false,
      byokProviderVisible: byokProvider ? getComputedStyle(byokProvider).display !== "none" : false,
      byokModelVisible: byokModel ? getComputedStyle(byokModel).display !== "none" : false,
      byokKeyVisible: byokKey ? getComputedStyle(byokKey).display !== "none" : false,
      managedServerHidden: managedServer ? getComputedStyle(managedServer).display === "none" : false
    };
  });
  pushCheck(
    "05 Setup defaults (neutral BYOK)",
    setupDefault.modeValue === "byok"
      && !setupDefault.modeRowHidden
      && setupDefault.byokProviderVisible
      && setupDefault.byokModelVisible
      && setupDefault.byokKeyVisible
      && setupDefault.managedServerHidden,
    `mode=${setupDefault.modeValue}, modeRowHidden=${setupDefault.modeRowHidden}, byokVisible=${setupDefault.byokProviderVisible}.`
  );

  await page.selectOption("#setup-mode", "managed");
  await page.waitForTimeout(400);
  const managedState = await page.evaluate(() => {
    const mode = document.querySelector("#setup-mode");
    const byokProvider = document.querySelector("#setup-byok-provider");
    const managedServer = document.querySelector("#setup-managed-server");
    const managedServerUrl = document.querySelector("#setup-managed-server-url");
    const classCode = document.querySelector("#setup-class-code");
    return {
      modeValue: mode ? mode.value : "",
      byokProviderHidden: byokProvider ? getComputedStyle(byokProvider).display === "none" : false,
      managedServerVisible: managedServer ? getComputedStyle(managedServer).display !== "none" : false,
      serverUrlVisible: managedServerUrl ? getComputedStyle(managedServerUrl).display !== "none" : false,
      classCodeVisible: classCode ? getComputedStyle(classCode).display !== "none" : false
    };
  });
  await page.screenshot({ path: screenshots.managed, fullPage: false });
  pushCheck(
    "06 Setup mode toggle (managed)",
    managedState.modeValue === "managed"
      && managedState.byokProviderHidden
      && managedState.managedServerVisible
      && managedState.serverUrlVisible
      && managedState.classCodeVisible,
    `mode=${managedState.modeValue}, serverUrlVisible=${managedState.serverUrlVisible}, classCodeVisible=${managedState.classCodeVisible}.`
  );

  await installFetchMock(page);
  await page.fill("#setup-server", "vibbit.tk.sg");
  await page.fill("#setup-class-code", "SMOKE-TESTA");
  await page.click("#setup-go");
  await page.waitForSelector("#go", { timeout: 20000 });

  const joinedState = await page.evaluate(() => ({
    connectCalls: Number(window.__smokeConnectCalls || 0),
    badge: document.querySelector("#classroom-badge")?.textContent || ""
  }));
  pushCheck(
    "07 Join verifies classroom on Get Started",
    joinedState.connectCalls === 1 && joinedState.badge.includes("Smoke Classroom"),
    `connectCalls=${joinedState.connectCalls}, badge='${joinedState.badge}'.`
  );

  await page.fill("#p", "Create a tiny managed program");
  await page.click("#go");
  await page.waitForFunction(() => {
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    return status === "Done" || status === "Error";
  }, { timeout: 30000 });

  const managedGenerationState = await page.evaluate(() => {
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    const pastedCode = window.__smokeMonacoValue || "";
    return {
      status,
      pastedCode,
      connectCalls: Number(window.__smokeConnectCalls || 0),
      managedCalls: Number(window.__smokeManagedCalls || 0)
    };
  });
  await page.screenshot({ path: screenshots.managedFeedback, fullPage: false });
  pushCheck(
    "08 Managed mocked generation",
    managedGenerationState.status === "Done"
      && managedGenerationState.connectCalls === 1
      && managedGenerationState.managedCalls === 1
      && managedGenerationState.pastedCode.includes("basic.showString(\"Managed\")"),
    `status='${managedGenerationState.status}', connectCalls=${managedGenerationState.connectCalls}, managedCalls=${managedGenerationState.managedCalls}.`
  );

  await page.evaluate(() => {
    localStorage.setItem("__vibbit_mode", "byok");
    localStorage.setItem("__vibbit_provider", "openai");
    localStorage.setItem("__vibbit_model", "gpt-5.2");
    localStorage.setItem("__vibbit_key_openai", "smoke-dummy-key");
  });
  await page.click("#gear");
  await page.waitForSelector("#set-mode", { timeout: 10000 });
  await page.selectOption("#set-mode", "byok");
  await page.waitForTimeout(200);
  await page.click("#back");
  await page.waitForSelector("#go", { timeout: 10000 });

  await page.fill("#p", "Create a tiny byok program");
  await page.click("#go");
  await page.waitForFunction(() => {
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    return status === "Done" || status === "Error";
  }, { timeout: 30000 });

  const byokGenerationState = await page.evaluate(() => {
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    const pastedCode = window.__smokeMonacoValue || "";
    const logText = document.querySelector("#log")?.textContent || "";
    return {
      status,
      pastedCode,
      logText,
      byokCalls: Number(window.__smokeByokCalls || 0),
      managedCalls: Number(window.__smokeManagedCalls || 0)
    };
  });
  await page.screenshot({ path: screenshots.byokFeedback, fullPage: false });
  pushCheck(
    "09 BYOK mocked generation",
    byokGenerationState.status === "Done"
      && byokGenerationState.pastedCode.includes("basic.showString(\"BYOK\")")
      && byokGenerationState.byokCalls >= 1,
    `status='${byokGenerationState.status}', byokCalls=${byokGenerationState.byokCalls}, managedCalls=${byokGenerationState.managedCalls}.`
  );

  const hasProbeLog = /Live decompile check (passed|unavailable|failed)/i.test(byokGenerationState.logText);
  pushCheck("10 Decompile probe log", hasProbeLog, `logHasProbeMessage=${hasProbeLog}.`);
}

async function runHostedUiSmoke(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // Ignore storage access errors.
      }
    });
    await page.goto("https://makecode.microbit.org/", { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(3000);

    const hostedRuntime = await readFile(path.join(repoRoot, "dist", "content-script.js"), "utf8");
    await page.addScriptTag({ content: hostedRuntime });
    await page.waitForSelector("#vibbit-fab", { timeout: 20000 });
    await page.click("#vibbit-fab");
    await page.waitForSelector("#setup-go", { timeout: 20000 });
    await page.screenshot({ path: screenshots.hostedPanel, fullPage: false });

    const hostedSetup = await page.evaluate(() => {
      const mode = document.querySelector("#setup-mode");
      const modeRow = document.querySelector("#setup-mode-row");
      const byokProvider = document.querySelector("#setup-byok-provider");
      const managedServerUrl = document.querySelector("#setup-managed-server-url");
      const classCode = document.querySelector("#setup-class-code");
      return {
        modeValue: mode ? mode.value : "",
        modeRowHidden: modeRow ? getComputedStyle(modeRow).display === "none" : false,
        byokHidden: byokProvider ? getComputedStyle(byokProvider).display === "none" : false,
        serverUrlHidden: managedServerUrl ? getComputedStyle(managedServerUrl).display === "none" : false,
        classCodeVisible: classCode ? getComputedStyle(classCode).display !== "none" : false
      };
    });
    pushCheck(
      "11 Hosted-managed UI is code-only",
      hostedSetup.modeValue === "managed"
        && hostedSetup.modeRowHidden
        && hostedSetup.byokHidden
        && hostedSetup.serverUrlHidden
        && hostedSetup.classCodeVisible,
      `mode=${hostedSetup.modeValue}, modeRowHidden=${hostedSetup.modeRowHidden}, serverUrlHidden=${hostedSetup.serverUrlHidden}.`
    );

    await installFetchMock(page);
    await page.fill("#setup-class-code", "HOSTEDCODE");
    await page.click("#setup-go");
    await page.waitForSelector("#go", { timeout: 20000 });
    const hostedJoin = await page.evaluate(() => ({
      connectCalls: Number(window.__smokeConnectCalls || 0),
      badge: document.querySelector("#classroom-badge")?.textContent || ""
    }));
    pushCheck(
      "12 Hosted join verifies classroom code",
      hostedJoin.connectCalls === 1 && hostedJoin.badge.includes("Smoke Classroom"),
      `connectCalls=${hostedJoin.connectCalls}, badge='${hostedJoin.badge}'.`
    );
  } finally {
    await page.close();
  }
}

async function runSmokeUi() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // Ignore storage access errors.
      }
    });

    await page.goto("https://makecode.microbit.org/", { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: screenshots.makecode, fullPage: false });
    pushCheck("01 MakeCode loads", true, `Screenshot saved at \`${screenshots.makecode}\`.`);

    await runNeutralUiSmoke(page);
    await runHostedUiSmoke(browser);
  } catch (error) {
    try {
      await page.screenshot({ path: screenshots.error, fullPage: true });
    } catch {
      // Keep primary failure instead of screenshot failure.
    }
    pushCheck("UI smoke execution", false, error && error.message ? error.message : String(error));
  } finally {
    await browser.close();
  }
}

await runBuildAndPackage();
await runSmokeUi();

const reportPath = path.join(runDir, "REPORT.md");
const screenshotList = [
  screenshots.makecode,
  screenshots.panel,
  screenshots.managed,
  screenshots.byok,
  screenshots.managedFeedback,
  screenshots.byokFeedback,
  screenshots.hostedPanel
].map((filePath) => `- \`${filePath}\``);

const report = [
  "# Playwright Smoke Audit",
  "",
  `- Date: ${new Date().toISOString()}`,
  `- Run directory: \`${runDir}\``,
  "",
  "## Checks",
  "",
  buildMarkdownTable(checks),
  "",
  "## Screenshots",
  "",
  ...screenshotList,
  "",
  "## Runtime source",
  "",
  `- Neutral source: \`${path.join(repoRoot, "work.js")}\``,
  `- Hosted package: \`${path.join(repoRoot, "dist", "content-script.js")}\``,
  "",
  "## Outcome",
  "",
  overallPass ? "PASS" : "FAIL"
].join("\n");

await writeText(reportPath, report + "\n");

console.log(`SUMMARY: ${overallPass ? "PASS" : "FAIL"}`);
console.log(`ARTEFACT_DIR: ${runDir}`);
console.log(`REPORT: ${reportPath}`);
console.log(`SCREENSHOTS: ${Object.values(screenshots).slice(0, 7).join(",")}`);

if (!overallPass) {
  process.exitCode = 1;
}
