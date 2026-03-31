const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");
const { execSync, spawn, execFileSync } = require("child_process");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.json({ ok: true, service: "Instantly OAuth Bot", time: new Date().toISOString() }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, selector, timeout = 10000) {
  try { await page.waitForSelector(selector, { visible: true, timeout }); return true; }
  catch { return false; }
}

async function humanType(page, selector, text) {
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, text, { delay: 60 + Math.random() * 60 });
}

// ── Detect Chrome ─────────────────────────────────────────────────────────────
function findChrome() {
  if (process.env.PUPPETEER_EXEC_PATH && fs.existsSync(process.env.PUPPETEER_EXEC_PATH))
    return process.env.PUPPETEER_EXEC_PATH;
  const candidates = [
    "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium",
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  try { return execFileSync("which", ["google-chrome-stable"], { encoding: "utf8" }).trim(); } catch {}
  try { return execFileSync("which", ["chromium-browser"], { encoding: "utf8" }).trim(); } catch {}
  return null;
}

async function ensureChrome() {
  const path = findChrome();
  if (path) { console.log("Chrome found:", path); return path; }
  console.log("Chrome not found, installing chromium-browser via apt...");
  try {
    execSync("apt-get update -qq && apt-get install -y chromium-browser --no-install-recommends", { stdio: "inherit", timeout: 180000 });
    if (fs.existsSync("/usr/bin/chromium-browser")) return "/usr/bin/chromium-browser";
  } catch (e) { console.log("apt install failed:", e.message); }
  try {
    const { executablePath } = require("puppeteer");
    const ep = executablePath();
    if (ep && fs.existsSync(ep)) return ep;
  } catch {}
  throw new Error("Could not find Chrome. Please deploy using the Dockerfile (Docker environment on Render).");
}

// ── Xvfb ──────────────────────────────────────────────────────────────────────
function startXvfb() {
  try { execSync("pkill Xvfb", { stdio: "ignore" }); } catch {}
  const xvfb = spawn("Xvfb", [":99", "-screen", "0", "1280x900x24"], { detached: true, stdio: "ignore" });
  xvfb.unref();
  process.env.DISPLAY = ":99";
  console.log("Xvfb started on :99");
}

let chromePath = null;

async function launchBrowser() {
  if (!chromePath) chromePath = await ensureChrome();
  const opts = {
    headless: false,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
           "--disable-gpu","--window-size=1280,900",
           "--disable-blink-features=AutomationControlled","--disable-infobars"],
    env: { ...process.env, DISPLAY: ":99" },
  };
  if (chromePath) opts.executablePath = chromePath;
  return puppeteer.launch(opts);
}

// ── Instantly API ─────────────────────────────────────────────────────────────
async function instantlyRequest(path, method, apiKey, body = null) {
  const opts = { method, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.instantly.ai/api/v2${path}`, opts);
  const j = await res.json();
  if (!res.ok) throw new Error(j.message || j.error || `Instantly ${res.status}`);
  return j;
}

async function initOAuth(apiKey, provider) {
  const endpoint = provider === "google" ? "/oauth/google/init" : "/oauth/microsoft/init";
  return instantlyRequest(endpoint, "POST", apiKey, {});
}

async function pollSession(apiKey, sessionId) {
  return instantlyRequest(`/oauth/session/status/${sessionId}`, "GET", apiKey);
}

async function accountExists(apiKey, email) {
  const j = await instantlyRequest(`/accounts?search=${encodeURIComponent(email)}&limit=5`, "GET", apiKey);
  return (j.items || []).some((a) => a.email?.toLowerCase() === email.toLowerCase());
}

// ── Microsoft login ───────────────────────────────────────────────────────────
async function loginMicrosoft(browser, authUrl, email, password) {
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(authUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(1500);

  const emailField = await waitFor(page, 'input[type="email"], input[name="loginfmt"]', 6000);
  if (emailField) {
    const cur = await page.$eval('input[type="email"], input[name="loginfmt"]', el => el.value).catch(() => "");
    if (!cur || !cur.includes("@")) {
      await humanType(page, 'input[type="email"], input[name="loginfmt"]', email);
      await sleep(400);
    }
    const next = await page.$('input[type="submit"], button[type="submit"]');
    if (next) { await next.click(); await sleep(2000); }
  }

  const passField = await waitFor(page, 'input[type="password"], input[name="passwd"]', 10000);
  if (!passField) throw new Error("Password field not found — account may need MFA or is locked");
  await humanType(page, 'input[type="password"], input[name="passwd"]', password);
  await sleep(500);

  const signIn = await page.$('input[type="submit"][value="Sign in"], button[type="submit"]');
  if (signIn) await signIn.click(); else await page.keyboard.press("Enter");
  await sleep(3000);

  // Stay signed in? → No
  const stay = await waitFor(page, '#idBtn_Back, input[value="No"]', 8000);
  if (stay) {
    const no = await page.$('#idBtn_Back, input[value="No"]');
    if (no) { await no.click(); await sleep(1500); }
  }

  await page.close();
}

// ── Google login ──────────────────────────────────────────────────────────────
async function loginGoogle(browser, authUrl, email, password) {
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(authUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(1500);

  const emailField = await waitFor(page, 'input[type="email"]', 8000);
  if (emailField) {
    const cur = await page.$eval('input[type="email"]', el => el.value).catch(() => "");
    if (!cur || !cur.includes("@")) {
      await humanType(page, 'input[type="email"]', email);
      await sleep(400);
    }
    await page.keyboard.press("Enter");
    await sleep(2500);
  }

  const passField = await waitFor(page, 'input[type="password"]', 10000);
  if (!passField) throw new Error("Google password field not found — check if 2FA is enabled");
  await humanType(page, 'input[type="password"]', password);
  await sleep(500);
  await page.keyboard.press("Enter");
  await sleep(3000);
  await page.close();
}

// ── Core: connect one account ─────────────────────────────────────────────────
async function loginAccount(apiKey, email, password, provider) {
  const session = await initOAuth(apiKey, provider);
  const sessionId = session.session_id || session.sessionId;
  let authUrl = session.auth_url || session.authUrl || "";
  if (!authUrl || !sessionId) throw new Error("Instantly did not return authUrl or sessionId");

  try {
    const u = new URL(authUrl);
    const prompts = u.searchParams.getAll("prompt");
    if (prompts.length > 1) { u.searchParams.delete("prompt"); u.searchParams.set("prompt", prompts[0]); }
    u.searchParams.set("login_hint", email);
    authUrl = u.toString();
  } catch {}

  const browser = await launchBrowser();
  try {
    if (provider === "google") await loginGoogle(browser, authUrl, email, password);
    else await loginMicrosoft(browser, authUrl, email, password);

    let connected = false, lastError = "";
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      try {
        const s = await pollSession(apiKey, sessionId);
        if (s.status === "success") { connected = true; break; }
        if (s.status === "error" || s.status === "expired") { lastError = s.error_description || s.error || s.status; break; }
      } catch {}
    }
    await browser.close();
    if (connected) return { ok: true };
    throw new Error(lastError || "Session did not complete — wrong password or MFA required");
  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post("/api/connect", async (req, res) => {
  const { apiKey, email, password, provider = "microsoft" } = req.body || {};
  if (!apiKey || !email || !password) return res.json({ ok: false, error: "Missing apiKey, email, or password" });
  try {
    const exists = await accountExists(apiKey, email);
    if (exists) return res.json({ ok: true, skipped: true });
    await loginAccount(apiKey, email, password, provider);
    res.json({ ok: true, skipped: false });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post("/api/check", async (req, res) => {
  const { apiKey, email } = req.body || {};
  if (!apiKey || !email) return res.json({ ok: false, error: "Missing apiKey or email" });
  try { res.json({ ok: true, exists: await accountExists(apiKey, email) }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post("/api/list", async (req, res) => {
  const { apiKey, skip = 0 } = req.body || {};
  if (!apiKey) return res.json({ ok: false, error: "Missing apiKey" });
  try {
    const j = await instantlyRequest(`/accounts?limit=100&skip=${skip}`, "GET", apiKey);
    res.json({ ok: true, accounts: j.items || [], total: j.total });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Server on port ${PORT}`);
  startXvfb();
  try { chromePath = await ensureChrome(); console.log("Chrome ready:", chromePath || "puppeteer bundled"); }
  catch (e) { console.error("Chrome setup warning:", e.message); }
});
