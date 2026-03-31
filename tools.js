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
  telegram: { max: 10, windowMs: 3600000 },        // 10/h
  publish: { max: 5, windowMs: 3600000 },          // 5/h
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

// ─── TELEGRAM BOT TOOL ──────────────────────────────────────────────────────

/**
 * Envoie un message sur un canal/chat Telegram via Bot API
 */
export async function telegramSendMessage(botToken, chatId, text, parseMode = "HTML") {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.substring(0, 4096), // Telegram limit
        parse_mode: parseMode,
        disable_web_page_preview: false,
      }),
    });
    const data = await response.json();
    if (!data.ok) return { success: false, error: data.description || "Telegram API error" };
    return { success: true, message_id: data.result.message_id, chat_id: chatId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Cree ou met a jour la description/bio du canal Telegram
 */
export async function telegramSetDescription(botToken, chatId, description) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/setChatDescription`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, description: description.substring(0, 255) }),
    });
    const data = await response.json();
    return { success: data.ok, error: data.ok ? null : data.description };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── GUMROAD API TOOL ───────────────────────────────────────────────────────

/**
 * Cree un produit sur Gumroad via API
 */
export async function gumroadCreateProduct(apiKey, productData) {
  try {
    const params = new URLSearchParams({
      access_token: apiKey,
      name: productData.name || "Product",
      price: String((productData.price_cents || 0)),
      description: (productData.description || "").substring(0, 5000),
      preview_url: productData.preview_url || "",
    });

    const response = await fetch("https://api.gumroad.com/v2/products", {
      method: "POST",
      body: params,
    });
    const data = await response.json();
    if (!data.success) return { success: false, error: data.message || "Gumroad API error" };
    return {
      success: true,
      product_id: data.product.id,
      url: data.product.short_url,
      name: data.product.name,
      price: data.product.price,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Liste les produits Gumroad existants
 */
export async function gumroadListProducts(apiKey) {
  try {
    const response = await fetch(`https://api.gumroad.com/v2/products?access_token=${apiKey}`);
    const data = await response.json();
    if (!data.success) return { success: false, error: data.message || "Gumroad API error" };
    return {
      success: true,
      products: (data.products || []).map(p => ({
        id: p.id, name: p.name, price: p.price,
        url: p.short_url, sales_count: p.sales_count,
      })),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
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
      // Publish via Gumroad API (create product) or Telegram (post message)
      if (infra.gumroad?.api_key && (action.target?.includes("gumroad") || action.expected_outcome?.includes("gumroad"))) {
        return await gumroadCreateProduct(infra.gumroad.api_key, {
          name: action.target || action.description?.substring(0, 80),
          price_cents: action.metadata?.price_cents || 900, // default 9€
          description: action.description || "",
        });
      }
      if (infra.telegram?.bot_token && infra.telegram?.channel_id) {
        return await telegramSendMessage(
          infra.telegram.bot_token,
          infra.telegram.channel_id,
          action.description || action.target || ""
        );
      }
      return { success: false, error: "Plateforme de publication non configuree (gumroad ou telegram requis)" };

    case "telegram":
      // Direct Telegram posting
      if (!infra.telegram?.bot_token) {
        return { success: false, error: "Telegram bot non configure" };
      }
      return await telegramSendMessage(
        infra.telegram.bot_token,
        infra.telegram.channel_id || action.target,
        action.description || ""
      );

    case "api_externe":
      // API externe (Make.com, Gumroad listing, etc.)
      if (action.target?.includes("gumroad") && infra.gumroad?.api_key) {
        return await gumroadListProducts(infra.gumroad.api_key);
      }
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
