const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");
const { execSync, spawn } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ ok: true, service: "Instantly OAuth Bot", time: new Date().toISOString() }));

// ── Helper: sleep ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helper: wait for selector safely ─────────────────────────────────────────
async function waitFor(page, selector, timeout = 10000) {
  try {
    await page.waitForSelector(selector, { visible: true, timeout });
    return true;
  } catch {
    return false;
  }
}

// ── Helper: type slowly like a human ─────────────────────────────────────────
async function humanType(page, selector, text) {
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, text, { delay: 60 + Math.random() * 60 });
}

// ── Launch browser with Xvfb ──────────────────────────────────────────────────
let xvfbProc = null;
function startXvfb() {
  try {
    execSync("pkill Xvfb", { stdio: "ignore" });
  } catch {}
  xvfbProc = spawn("Xvfb", [":99", "-screen", "0", "1280x900x24"], { detached: true, stdio: "ignore" });
  xvfbProc.unref();
  process.env.DISPLAY = ":99";
  console.log("Xvfb started on :99");
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: false,
    executablePath: process.env.PUPPETEER_EXEC_PATH || "/usr/bin/google-chrome-stable",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,900",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
    ],
    env: { ...process.env, DISPLAY: ":99" },
  });
}

// ── Instantly API helpers ─────────────────────────────────────────────────────
async function instantlyRequest(path, method, apiKey, body = null) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.instantly.ai/api/v2${path}`, opts);
  const j = await res.json();
  if (!res.ok) throw new Error(j.message || j.error || `Instantly ${res.status}`);
  return j;
}

async function initOAuth(apiKey) {
  return instantlyRequest("/oauth/microsoft/init", "POST", apiKey, {});
}

async function pollSession(apiKey, sessionId) {
  return instantlyRequest(`/oauth/session/status/${sessionId}`, "GET", apiKey);
}

async function accountExists(apiKey, email) {
  const j = await instantlyRequest(`/accounts?search=${encodeURIComponent(email)}&limit=5`, "GET", apiKey);
  return (j.items || []).some((a) => a.email?.toLowerCase() === email.toLowerCase());
}

// ── Core: login one account ───────────────────────────────────────────────────
async function loginAccount(apiKey, email, password) {
  // 1. Init OAuth session from Instantly
  const session = await initOAuth(apiKey);
  const sessionId = session.session_id || session.sessionId;
  let authUrl = session.auth_url || session.authUrl || "";

  if (!authUrl || !sessionId) throw new Error("Instantly did not return authUrl or sessionId");

  // Fix duplicate prompt param (Instantly bug)
  try {
    const u = new URL(authUrl);
    const prompts = u.searchParams.getAll("prompt");
    if (prompts.length > 1) {
      u.searchParams.delete("prompt");
      u.searchParams.set("prompt", prompts[0]);
    }
    // Pre-fill email via login_hint
    u.searchParams.set("login_hint", email);
    authUrl = u.toString();
  } catch {}

  // 2. Open browser and navigate
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.goto(authUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(1500);

    // 3. Type email if not pre-filled
    const emailField = await waitFor(page, 'input[type="email"], input[name="loginfmt"]', 6000);
    if (emailField) {
      const currentVal = await page.$eval(
        'input[type="email"], input[name="loginfmt"]',
        (el) => el.value
      ).catch(() => "");
      if (!currentVal || !currentVal.includes("@")) {
        await humanType(page, 'input[type="email"], input[name="loginfmt"]', email);
        await sleep(400);
      }
      // Click Next
      const nextBtn = await page.$('input[type="submit"], button[type="submit"]');
      if (nextBtn) {
        await nextBtn.click();
        await sleep(2000);
      }
    }

    // 4. Type password
    const passField = await waitFor(page, 'input[type="password"], input[name="passwd"]', 10000);
    if (!passField) throw new Error("Password field not found — check if account needs MFA or is locked");

    await humanType(page, 'input[type="password"], input[name="passwd"]', password);
    await sleep(500);

    // 5. Click Sign in
    const signInBtn = await page.$('input[type="submit"][value="Sign in"], button[type="submit"]');
    if (signInBtn) {
      await signInBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await sleep(3000);

    // 6. Handle "Stay signed in?" → click No
    const staySignedIn = await waitFor(page, '#idBtn_Back, input[value="No"]', 8000);
    if (staySignedIn) {
      const noBtn = await page.$('#idBtn_Back, input[value="No"]');
      if (noBtn) {
        await noBtn.click();
        await sleep(1500);
      }
    }

    // 7. Poll Instantly session until success or error
    let connected = false;
    let lastError = "";
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      try {
        const status = await pollSession(apiKey, sessionId);
        if (status.status === "success") {
          connected = true;
          break;
        }
        if (status.status === "error" || status.status === "expired") {
          lastError = status.error_description || status.error || status.status;
          break;
        }
      } catch {}
    }

    await browser.close();

    if (connected) return { ok: true };
    throw new Error(lastError || "Session did not complete — possible wrong password or MFA required");
  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}

// ── POST /api/connect ─────────────────────────────────────────────────────────
// Body: { apiKey, email, password }
app.post("/api/connect", async (req, res) => {
  const { apiKey, email, password } = req.body || {};
  if (!apiKey || !email || !password) {
    return res.json({ ok: false, error: "Missing apiKey, email, or password" });
  }
  try {
    // Check if already exists
    const exists = await accountExists(apiKey, email);
    if (exists) return res.json({ ok: true, skipped: true });

    await loginAccount(apiKey, email, password);
    res.json({ ok: true, skipped: false });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── POST /api/check ───────────────────────────────────────────────────────────
app.post("/api/check", async (req, res) => {
  const { apiKey, email } = req.body || {};
  if (!apiKey || !email) return res.json({ ok: false, error: "Missing apiKey or email" });
  try {
    const exists = await accountExists(apiKey, email);
    res.json({ ok: true, exists });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── POST /api/list ────────────────────────────────────────────────────────────
app.post("/api/list", async (req, res) => {
  const { apiKey, skip = 0 } = req.body || {};
  if (!apiKey) return res.json({ ok: false, error: "Missing apiKey" });
  try {
    const j = await instantlyRequest(`/accounts?limit=100&skip=${skip}`, "GET", apiKey);
    res.json({ ok: true, accounts: j.items || [], total: j.total });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startXvfb();
});
