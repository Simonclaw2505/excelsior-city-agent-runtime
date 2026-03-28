/**
 * EXCELSIOR CITY — Tool Execution Engine v2
 * Execution reelle des outils + rate limiting par outil + securite renforcee
 */

import puppeteer from "puppeteer";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";

// ─── Tool Rate Limiting ─────────────────────────────────────────────────────

const toolUsage = {};
const TOOL_LIMITS = {
  web_search: { max: 20, windowMs: 3600000 },    // 20/h
  browser: { max: 15, windowMs: 3600000 },        // 15/h
  email_outreach: { max: 5, windowMs: 3600000 },  // 5/h (anti-spam)
  publish: { max: 3, windowMs: 3600000 },          // 3/h
};

function checkToolLimit(toolName) {
  const limit = TOOL_LIMITS[toolName];
  if (!limit) return true;

  const now = Date.now();
  if (!toolUsage[toolName]) toolUsage[toolName] = [];
  toolUsage[toolName] = toolUsage[toolName].filter(t => now - t < limit.windowMs);

  if (toolUsage[toolName].length >= limit.max) {
    console.warn(`⚠️ TOOL RATE LIMIT: ${toolName} (${toolUsage[toolName].length}/${limit.max}/h)`);
    return false;
  }
  toolUsage[toolName].push(now);
  return true;
}

// ─── URL Validation ─────────────────────────────────────────────────────────

const BLOCKED_DOMAINS = [
  "localhost", "127.0.0.1", "0.0.0.0", "169.254.", "10.", "172.16.", "192.168.",
  "metadata.google", "metadata.aws", "instance-data",
];

function isUrlSafe(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    for (const blocked of BLOCKED_DOMAINS) {
      if (parsed.hostname.includes(blocked) || parsed.hostname.startsWith(blocked)) return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return true;
  } catch {
    return false;
  }
}

// ─── BROWSER TOOL ────────────────────────────────────────────────────────────

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });
  }
  return browserInstance;
}

/**
 * Navigue vers une URL et retourne le contenu texte de la page
 */
export async function browserNavigate(url) {
  if (!isUrlSafe(url)) return { success: false, error: `URL bloquee: ${url}` };
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      // Block dangerous resource types
      const blocked = ["media", "font"];
      if (blocked.includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.setUserAgent("Mozilla/5.0 (X11; Linux aarch64) ExcelsiorBot/1.0");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText.substring(0, 5000));
    const title = await page.title();
    return { success: true, title, text, url };
  } catch (e) {
    return { success: false, error: e.message, url };
  } finally {
    await page.close();
  }
}

/**
 * Remplit un formulaire et le soumet (inscription, login, etc.)
 */
export async function browserFillForm(url, fields, submitSelector = 'button[type="submit"]') {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (X11; Linux aarch64) ExcelsiorBot/1.0");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    for (const [selector, value] of Object.entries(fields)) {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector, { clickCount: 3 }); // select all
      await page.type(selector, value, { delay: 50 });
    }

    if (submitSelector) {
      await page.click(submitSelector);
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    }

    const text = await page.evaluate(() => document.body.innerText.substring(0, 3000));
    const currentUrl = page.url();
    return { success: true, url: currentUrl, text };
  } catch (e) {
    return { success: false, error: e.message, url };
  } finally {
    await page.close();
  }
}

/**
 * Prend un screenshot d'une page (pour debug/preuve)
 */
export async function browserScreenshot(url, path = "/tmp/screenshot.png") {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.screenshot({ path, fullPage: false });
    return { success: true, path };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    await page.close();
  }
}

// ─── WEB SEARCH TOOL ─────────────────────────────────────────────────────────

/**
 * Recherche web via DuckDuckGo HTML (pas d'API key nécessaire)
 */
export async function webSearch(query) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 15000 });

    const results = await page.evaluate(() => {
      const items = document.querySelectorAll(".result");
      return Array.from(items).slice(0, 8).map((el) => ({
        title: el.querySelector(".result__title")?.innerText || "",
        url: el.querySelector(".result__url")?.innerText?.trim() || "",
        snippet: el.querySelector(".result__snippet")?.innerText || "",
      }));
    });

    return { success: true, query, results };
  } catch (e) {
    return { success: false, error: e.message, query };
  } finally {
    await page.close();
  }
}

// ─── EMAIL OUTREACH TOOL ─────────────────────────────────────────────────────

/**
 * Envoie un email via SMTP (credentials dans agent.infrastructure.mailbox)
 */
export async function sendEmail(mailboxConfig, to, subject, body) {
  try {
    const transporter = nodemailer.createTransport({
      host: mailboxConfig.smtp,
      port: 465,
      secure: true,
      auth: {
        user: mailboxConfig.email || `${mailboxConfig.smtp.split(".").pop()}`,
        pass: mailboxConfig.password,
      },
      tls: { rejectUnauthorized: false },
    });

    const info = await transporter.sendMail({
      from: mailboxConfig.from_name
        ? `"${mailboxConfig.from_name}" <${mailboxConfig.email}>`
        : mailboxConfig.email,
      to,
      subject,
      text: body,
    });

    return { success: true, messageId: info.messageId, to, subject };
  } catch (e) {
    return { success: false, error: e.message, to, subject };
  }
}

// ─── EMAIL READING (IMAP) ────────────────────────────────────────────────────

/**
 * Lit les emails récents (déjà dans le runtime, mais exposé ici pour cohérence)
 */
export async function readEmails(imapConfig, maxCount = 10) {
  const client = new ImapFlow({
    host: imapConfig.imap,
    port: 993,
    secure: true,
    auth: { user: imapConfig.email, pass: imapConfig.password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  const emails = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const messages = client.fetch({ since, seen: false }, { envelope: true });
      let count = 0;
      for await (const msg of messages) {
        if (count >= maxCount) break;
        emails.push({
          uid: msg.uid,
          from: msg.envelope.from?.[0]?.address || "unknown",
          subject: msg.envelope.subject || "(sans sujet)",
          date: msg.envelope.date?.toISOString() || new Date().toISOString(),
        });
        count++;
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.warn(`IMAP error: ${e.message}`);
  }
  return emails;
}

// ─── TOOL EXECUTOR ───────────────────────────────────────────────────────────

/**
 * Execute une action planifiée par l'agent
 * Retourne le résultat de l'exécution
 */
export async function executeTool(action, agent) {
  const tool = action.tool;
  const infra = agent.infrastructure || {};
  const mailbox = infra.mailbox || {};
  const email = infra.email;

  // Rate limit check
  if (!checkToolLimit(tool)) {
    return { success: false, error: `Rate limit atteint pour ${tool}` };
  }

  switch (tool) {
    case "web_search":
      return await webSearch(action.target || action.description);

    case "browser":
      if (!isUrlSafe(action.target)) {
        return { success: false, error: `URL bloquee (securite): ${action.target}` };
      }
      return await browserNavigate(action.target || action.description);

    case "email_outreach":
      if (!email || !mailbox.password) {
        return { success: false, error: "Mailbox non configuree pour cet agent" };
      }
      return await sendEmail(
        { smtp: mailbox.smtp, email, password: mailbox.password, from_name: `${agent.symbol} ${agent.name}` },
        action.target,
        action.description?.substring(0, 100) || "Message de " + agent.name,
        action.description || ""
      );

    case "write":
      // Write est natif Claude — pas d'exécution externe nécessaire
      return { success: true, note: "Contenu genere par Claude dans le cycle" };

    case "publish":
      // Publish nécessite les credentials de la plateforme (Gumroad etc.)
      if (action.target?.includes("gumroad") && infra.gumroad?.api_key) {
        return await browserNavigate(action.target);
      }
      return { success: false, error: "Plateforme de publication non configuree" };

    case "api_externe":
      // API externe (Make.com etc.) — nécessite les credentials
      if (infra.make?.api_token) {
        return { success: true, note: "Make.com disponible", api_token: "configured" };
      }
      return { success: false, error: "API externe non configuree" };

    default:
      return { success: false, error: `Outil inconnu: ${tool}` };
  }
}

/**
 * Ferme proprement le navigateur
 */
export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
