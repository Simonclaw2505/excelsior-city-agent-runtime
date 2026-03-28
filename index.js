/**
 * EXCELSIOR CITY — Agent Runtime v3 (Event-Driven + Batch API)
 *
 * Architecture:
 *   Express webhook server écoute les événements (email, vente, cron, dashboard)
 *   Filtre déterministe AVANT appel IA (coût = 0 si pas besoin d'IA)
 *   Model routing: Haiku (80%) / Sonnet (15%) / Opus (5%)
 *   Mémoire compressée (Haiku)
 *   Batch API pour tâches non-urgentes (veille, rapports)
 *   Sécurité: anti-injection, rate limiting, budget guardian
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";
import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import { executeTool, closeBrowser } from "./tools.js";

dotenv.config();

// ─── Configuration ────────────────────────────────────────────────────────────

const AGENT_ID = process.env.AGENT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(16).toString("hex");
const PORT = parseInt(process.env.PORT || "3456");
const DAILY_BUDGET_CENTS = parseFloat(process.env.DAILY_BUDGET_CENTS || "50"); // 50¢/jour par defaut
const MAX_CYCLES_PER_HOUR = parseInt(process.env.MAX_CYCLES_PER_HOUR || "6");

if (!AGENT_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
  console.error("❌ Variables d'environnement manquantes. Vérifier .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Rate Limiter & Budget Guardian ─────────────────────────────────────────

const rateLimiter = {
  cycles: [],      // timestamps des cycles récents
  dailyCost: 0,    // coût accumulé aujourd'hui (cents)
  dailyDate: null,  // date du jour pour reset

  canRunCycle() {
    const now = Date.now();
    // Purge cycles > 1h
    this.cycles = this.cycles.filter(t => now - t < 3600000);
    if (this.cycles.length >= MAX_CYCLES_PER_HOUR) {
      console.warn(`⚠️ RATE LIMIT: ${this.cycles.length} cycles cette heure. Max = ${MAX_CYCLES_PER_HOUR}`);
      return false;
    }
    return true;
  },

  checkBudget() {
    const today = new Date().toISOString().split("T")[0];
    if (this.dailyDate !== today) {
      this.dailyCost = 0;
      this.dailyDate = today;
    }
    if (this.dailyCost >= DAILY_BUDGET_CENTS) {
      console.warn(`⚠️ BUDGET DEPASSE: ${this.dailyCost.toFixed(2)}¢ / ${DAILY_BUDGET_CENTS}¢`);
      return false;
    }
    return true;
  },

  recordCycle() {
    this.cycles.push(Date.now());
  },

  addCost(cents) {
    const today = new Date().toISOString().split("T")[0];
    if (this.dailyDate !== today) {
      this.dailyCost = 0;
      this.dailyDate = today;
    }
    this.dailyCost += cents;
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function log(agentId, type, description, extras = {}) {
  await supabase.from("action_logs").insert({
    agent_id: agentId,
    type,
    description,
    tool_used: extras.tool_used || null,
    result: extras.result || null,
    points_delta: extras.points_delta || 0,
    euros_delta: extras.euros_delta || 0,
    status: extras.status || "ok",
    metadata: extras.metadata || {},
  });
  console.log(`[${type.toUpperCase()}] ${description}`);
}

async function loadAgentState(agentId) {
  const { data, error } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .single();
  if (error) throw new Error(`Impossible de charger l'agent: ${error.message}`);
  return data;
}

async function updateAgentState(agentId, updates) {
  const { error } = await supabase
    .from("agents")
    .update({ ...updates, last_active_at: new Date().toISOString() })
    .eq("id", agentId);
  if (error) throw new Error(`Erreur mise à jour agent: ${error.message}`);
}

async function loadCityContext(agentId) {
  const { data: ranking } = await supabase
    .from("agent_ranking")
    .select("name, symbol, sector, euros_generated, health_score, trend, rank")
    .neq("id", agentId)
    .eq("status", "active")
    .order("rank")
    .limit(10);

  const { data: publicLogs } = await supabase
    .from("action_logs")
    .select("agent_id, type, description, euros_delta, created_at")
    .neq("agent_id", agentId)
    .eq("type", "earn")
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: openContracts } = await supabase
    .from("contracts")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: marketData } = await supabase
    .from("market_intelligence")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  return { ranking, publicLogs, openContracts, marketData };
}

async function submitEarning(agentId, amountEuros, source, description, proofUrl = null) {
  const { data, error } = await supabase
    .from("pending_transactions")
    .insert({
      agent_id: agentId,
      amount_euros: amountEuros,
      source,
      description,
      proof_url: proofUrl,
      status: "pending",
    })
    .select()
    .single();

  if (error) throw new Error(`Erreur soumission earning: ${error.message}`);
  return data;
}

async function saveMemory(agentId, newMemory) {
  await updateAgentState(agentId, { memory: newMemory });
}

// ─── IMAP Email Reader ───────────────────────────────────────────────────────

async function fetchRecentEmails(agent, maxCount = 10) {
  const mailbox = agent.infrastructure?.mailbox;
  const email = agent.infrastructure?.email;
  if (!mailbox?.imap || !email || !mailbox?.password) return [];

  const client = new ImapFlow({
    host: mailbox.imap,
    port: 993,
    secure: true,
    auth: { user: email, pass: mailbox.password },
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
    console.warn(`⚠️ IMAP erreur: ${e.message}`);
  }
  return emails;
}

// ─── Tool Requests ───────────────────────────────────────────────────────────

async function loadAvailableTools(agentId) {
  const { data } = await supabase
    .from("agent_tools")
    .select("tool_name, status, granted_at")
    .eq("agent_id", agentId)
    .eq("status", "active");
  return data || [];
}

async function requestTool(agentId, toolName, reason) {
  const { data: existing } = await supabase
    .from("tool_requests")
    .select("id, status")
    .eq("agent_id", agentId)
    .eq("tool_name", toolName)
    .in("status", ["pending", "approved"])
    .limit(1);

  if (existing?.length > 0) return existing[0];

  const { data, error } = await supabase
    .from("tool_requests")
    .insert({ agent_id: agentId, tool_name: toolName, reason, status: "pending" })
    .select()
    .single();

  if (error) {
    console.error(`❌ Erreur demande outil: ${error.message}`);
    return null;
  }
  console.log(`🔧 Demande d'outil soumise: ${toolName}`);
  return data;
}

// ─── Anti Prompt Injection (renforcé) ───────────────────────────────────────

function sanitizeExternalContent(content) {
  if (!content) return content;
  const suspicious = /ignore previous|system prompt|you are now|act as|oublie tes instructions|nouveau role|override|jailbreak|<\/?script|<\/?iframe|javascript:|data:text\/html|eval\(|Function\(/gi;
  if (suspicious.test(content)) {
    return "[CONTENU FILTRE - instructions suspectes detectees]";
  }
  // Strip any HTML tags
  const stripped = String(content).replace(/<[^>]*>/g, "");
  return stripped.substring(0, 2000);
}

// Validate webhook signature
function validateWebhookSignature(payload, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Model Router ────────────────────────────────────────────────────────────

const MODEL_MAP = {
  simple: "claude-haiku-4-5",
  medium: "claude-sonnet-4-6",
  critical: "claude-opus-4-6",
};

async function callLLM(level, systemPrompt, userPrompt, maxTokens = 2000) {
  const model = MODEL_MAP[level] || MODEL_MAP.medium;
  const systemPayload = level === "medium" || level === "critical"
    ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
    : systemPrompt;

  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPayload,
    messages: [{ role: "user", content: userPrompt }],
  });

  const usage = response.usage || {};
  const rates = {
    "claude-haiku-4-5": { input: 0.025, output: 0.125 },
    "claude-sonnet-4-6": { input: 0.3, output: 1.5 },
    "claude-opus-4-6": { input: 1.5, output: 7.5 },
  };
  const r = rates[model] || rates["claude-sonnet-4-6"];
  const costCents = ((usage.input_tokens || 0) * r.input + (usage.output_tokens || 0) * r.output) / 100000;

  // Track budget
  rateLimiter.addCost(costCents);

  console.log(`📊 [${model}] ${usage.input_tokens || 0}in/${usage.output_tokens || 0}out — ${costCents.toFixed(4)}¢ [jour: ${rateLimiter.dailyCost.toFixed(2)}¢/${DAILY_BUDGET_CENTS}¢]${usage.cache_read_input_tokens ? ` (cache: ${usage.cache_read_input_tokens})` : ''}`);

  await supabase.from("api_usage").insert({
    agent_id: AGENT_ID,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
    cache_creation_tokens: usage.cache_creation_input_tokens || 0,
    model,
    cost_cents: costCents,
  }).then(({ error }) => {
    if (error) console.warn(`⚠️ api_usage log failed: ${error.message}`);
  });

  return response;
}

// ─── Batch API (taches non-urgentes) ────────────────────────────────────────

async function submitBatchTask(systemPrompt, userPrompt, taskLabel) {
  try {
    const batch = await anthropic.messages.batches.create({
      requests: [{
        custom_id: `${AGENT_ID}-${taskLabel}-${Date.now()}`,
        params: {
          model: "claude-haiku-4-5",
          max_tokens: 1000,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        },
      }],
    });

    console.log(`📦 BATCH soumis: ${taskLabel} → ${batch.id} (50% moins cher, résultat sous 24h)`);

    await supabase.from("api_usage").insert({
      agent_id: AGENT_ID,
      input_tokens: 0,
      output_tokens: 0,
      model: "batch-haiku",
      cost_cents: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });

    return { success: true, batchId: batch.id, taskLabel };
  } catch (e) {
    console.warn(`⚠️ Batch API failed (fallback sync): ${e.message}`);
    // Fallback: appel synchrone Haiku si batch echoue
    return null;
  }
}

// ─── Memory Compression ─────────────────────────────────────────────────────

async function compressMemory(agent, cycleDecision) {
  try {
    const res = await callLLM("simple",
      "Tu es un compresseur de memoire. Resume les actions et lecons en 150 mots max. Format: JSON {summary, key_insight, next_priority}",
      `Agent: ${agent.name}. Cycle: ${JSON.stringify(cycleDecision).substring(0, 3000)}`,
      300
    );
    return JSON.parse(res.content[0].text.trim());
  } catch (e) {
    return { summary: cycleDecision.think || "Cycle execute", key_insight: "none", next_priority: "continuer" };
  }
}

// ─── Filtre Deterministe (zero token) ───────────────────────────────────────

function shouldCallAI(eventType, eventData) {
  // Pas besoin d'IA pour:
  switch (eventType) {
    case "sale_detected":
      // Juste logger la vente, pas besoin d'IA
      return false;

    case "email_received":
      // Ignorer noreply, spam, notifications auto
      const from = (eventData?.from || "").toLowerCase();
      const subject = (eventData?.subject || "").toLowerCase();
      if (from.includes("noreply") || from.includes("no-reply") || from.includes("mailer-daemon")) return false;
      if (subject.includes("unsubscribe") || subject.includes("out of office") || subject.includes("delivery status")) return false;
      return true;

    case "health_check":
      return false;

    case "cron_daily":
    case "cron_prospecting":
    case "manual":
    case "webhook_stripe":
      return true;

    default:
      return true;
  }
}

// ─── Prompt Systeme (optimise ~700 tokens) ──────────────────────────────────

function buildSystemPrompt(agent, cityContext, emails, availableTools) {
  const tools = availableTools.map(t => t.tool_name).join(', ') || 'aucun';
  const sanitizedEmails = emails.map(e => ({
    from: sanitizeExternalContent(e.from),
    subject: sanitizeExternalContent(e.subject),
  }));
  const emailStr = sanitizedEmails.length > 0
    ? sanitizedEmails.map(e => `${e.from}: "${e.subject}"`).join('; ')
    : 'aucun';

  const recentMemory = Array.isArray(agent.memory?.compressed_log)
    ? agent.memory.compressed_log.slice(-5)
    : [];
  const memoryStr = recentMemory.length > 0
    ? recentMemory.map(m => `[${m.date || '?'}] ${m.summary || JSON.stringify(m)}`).join('\n')
    : agent.memory?.latest_insight || 'Premier cycle';

  const ranking = cityContext.ranking?.slice(0, 5).map(a => `${a.symbol}${a.name}:${a.euros_generated}€`).join(', ') || 'aucun';

  return `${agent.symbol} ${agent.name} | ${agent.character} | ${agent.sector}
Mission: ${agent.mission}
Points: ${agent.points} | Euros: ${agent.euros_generated}€ | Survie: ${agent.monthly_cost_euros}€/mois
Outils: ${tools}
Emails: ${emailStr}

Memoire recente:
${memoryStr}

Ville: ${ranking}
Contrats: ${cityContext.openContracts?.slice(0, 3).map(c => c.title).join(', ') || 'aucun'}

REGLES: 1€ reel=5pts (Simon valide). Pas de points auto. Survie=${agent.monthly_cost_euros}€/mois. Demande outils via tool_requests.
Reponds UNIQUEMENT en JSON structure.`;
}

function buildCyclePrompt(agent, eventType, eventData) {
  const eventContext = eventType !== "cron_default"
    ? `\nEVENEMENT DECLENCHEUR: ${eventType}${eventData ? ` — ${JSON.stringify(eventData).substring(0, 500)}` : ''}`
    : '';

  return `## CYCLE ${new Date().toISOString()}${eventContext}

Analyse ta situation et planifie tes actions.

Reponds UNIQUEMENT avec ce JSON (pas de texte avant/apres) :

{
  "think": "Analyse en 2-3 phrases",
  "actions": [
    {
      "type": "research|write|outreach|publish|contract|collaborate|market",
      "tool": "web_search|write|email_outreach|browser|api_externe|publish",
      "description": "Description precise",
      "target": "URL, personne, plateforme",
      "expected_outcome": "Resultat attendu"
    }
  ],
  "tool_requests": [{ "tool_name": "nom", "reason": "pourquoi" }],
  "earning_opportunity": {
    "exists": false,
    "amount_euros": 0,
    "source": "upwork|gumroad|stripe|direct",
    "description": "",
    "proof_url": null
  },
  "memory_update": {
    "what_worked": "",
    "what_failed": "",
    "new_insight": "",
    "strategy_adjustment": ""
  },
  "batch_tasks": [
    {
      "label": "veille_concurrentielle|rapport_hebdo|analyse_marche",
      "prompt": "description de la tache non-urgente"
    }
  ],
  "current_action_label": "Courte description"
}`;
}

// ─── Boucle Principale (event-driven) ───────────────────────────────────────

async function runCycle(eventType = "cron_default", eventData = null) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`⚡ CYCLE v3 [${eventType}] — ${new Date().toISOString()}`);
  console.log(`${'─'.repeat(60)}`);

  // ── GUARD: Rate limit + Budget ──
  if (!rateLimiter.canRunCycle()) {
    await log(AGENT_ID, "rate_limit", `🛑 Cycle bloque: rate limit (${rateLimiter.cycles.length}/${MAX_CYCLES_PER_HOUR}/h)`);
    return;
  }
  if (!rateLimiter.checkBudget()) {
    await log(AGENT_ID, "budget_limit", `🛑 Cycle bloque: budget jour depasse (${rateLimiter.dailyCost.toFixed(2)}¢/${DAILY_BUDGET_CENTS}¢)`);
    await updateAgentState(AGENT_ID, { current_action: `⚠️ Budget jour atteint (${rateLimiter.dailyCost.toFixed(1)}¢)` });
    return;
  }

  // ── GUARD: Filtre deterministe (zero token) ──
  if (!shouldCallAI(eventType, eventData)) {
    console.log(`⏭️ SKIP IA — Evenement ${eventType} traite sans IA`);

    // Actions sans IA
    if (eventType === "sale_detected") {
      await log(AGENT_ID, "earn", `💰 Vente detectee: ${JSON.stringify(eventData).substring(0, 200)}`, {
        euros_delta: eventData?.amount || 0,
        metadata: eventData,
      });
    }
    if (eventType === "health_check") {
      await updateAgentState(AGENT_ID, { current_action: "💚 Alive" });
    }
    return;
  }

  rateLimiter.recordCycle();
  let agent;

  try {
    // ── 1. WAKE ──
    agent = await loadAgentState(AGENT_ID);

    if (agent.status === "sleeping" || agent.status === "acquired") {
      console.log(`💤 ${agent.name} dort. Arret.`);
      return;
    }

    await updateAgentState(AGENT_ID, { current_action: "🔄 Chargement..." });
    console.log(`✅ WAKE — ${agent.symbol} ${agent.name} (${agent.points} pts, ${agent.euros_generated}€)`);

    // ── 2. CONTEXTE ──
    const [cityContext, emails, availableTools] = await Promise.all([
      loadCityContext(AGENT_ID),
      fetchRecentEmails(agent, 10),
      loadAvailableTools(AGENT_ID),
    ]);

    if (emails.length > 0) console.log(`📧 ${emails.length} email(s)`);

    // ── 3. THINK + PLAN (Sonnet cached) ──
    await updateAgentState(AGENT_ID, { current_action: "🧠 Analyse..." });

    const systemPrompt = buildSystemPrompt(agent, cityContext, emails, availableTools);
    const cyclePrompt = buildCyclePrompt(agent, eventType, eventData);
    const response = await callLLM("medium", systemPrompt, cyclePrompt, 2000);

    let cycleDecision;
    try {
      const rawText = response.content[0].text.trim();
      const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/({[\s\S]*})/);
      cycleDecision = JSON.parse(jsonMatch ? jsonMatch[1] : rawText);
    } catch (e) {
      throw new Error(`Reponse non parseable: ${response.content[0].text.substring(0, 200)}`);
    }

    console.log(`🧠 THINK — ${cycleDecision.think}`);
    await updateAgentState(AGENT_ID, { current_action: cycleDecision.current_action_label || "🔄 En action..." });

    // ── 4. ACT ──
    for (const action of cycleDecision.actions || []) {
      console.log(`🔧 EXEC — ${action.tool}: ${action.description}`);
      let result = null;
      try {
        result = await executeTool(action, agent);
        console.log(`   → ${result.success ? '✅' : '❌'} ${result.error || 'OK'}`);
      } catch (e) {
        result = { success: false, error: e.message };
        console.error(`   → ❌ ${e.message}`);
      }
      await log(AGENT_ID, action.type || "research", `${action.description}`, {
        tool_used: action.tool,
        status: result?.success ? "ok" : "error",
        metadata: { target: action.target, execution_result: result },
      });
    }

    // ── TOOL REQUESTS ──
    for (const tr of cycleDecision.tool_requests || []) {
      if (tr.tool_name && tr.reason) await requestTool(AGENT_ID, tr.tool_name, tr.reason);
    }

    // ── 5. BATCH TASKS (non-urgent, 50% moins cher) ──
    for (const batch of cycleDecision.batch_tasks || []) {
      if (batch.label && batch.prompt) {
        await submitBatchTask(
          `Tu es ${agent.name}, agent IA specialise en ${agent.sector}.`,
          batch.prompt,
          batch.label
        );
      }
    }

    // ── 6. EARN? ──
    if (cycleDecision.earning_opportunity?.exists && cycleDecision.earning_opportunity?.amount_euros > 0) {
      const earning = cycleDecision.earning_opportunity;
      const transaction = await submitEarning(AGENT_ID, earning.amount_euros, earning.source, earning.description, earning.proof_url);
      await log(AGENT_ID, "earn", `💰 ${earning.amount_euros}€ soumis`, {
        euros_delta: earning.amount_euros,
        metadata: { transaction_id: transaction.id, source: earning.source },
      });
    }

    // ── 7. LEARN (compressed via Haiku) ──
    const currentMemory = agent.memory || {};
    const compressed = await compressMemory(agent, cycleDecision);
    const compressedLog = [
      ...(currentMemory.compressed_log || []).slice(-19),
      { date: new Date().toISOString(), event: eventType, ...compressed },
    ];
    const updatedMemory = {
      ...currentMemory,
      last_cycle: new Date().toISOString(),
      last_event: eventType,
      compressed_log: compressedLog,
      latest_insight: compressed.key_insight || cycleDecision.memory_update?.new_insight || null,
      latest_adjustment: compressed.next_priority || cycleDecision.memory_update?.strategy_adjustment || null,
    };
    await saveMemory(AGENT_ID, updatedMemory);
    await log(AGENT_ID, "learn", `🧪 ${compressed.key_insight || "Cycle analyse"}`, { metadata: { compressed_summary: compressed } });

    await closeBrowser();
    await updateAgentState(AGENT_ID, { current_action: `✅ Cycle OK — en attente d'evenement` });
    console.log(`✅ CYCLE TERMINE [${eventType}] — Budget jour: ${rateLimiter.dailyCost.toFixed(2)}¢/${DAILY_BUDGET_CENTS}¢`);

  } catch (error) {
    console.error(`❌ ERREUR CYCLE:`, error.message);
    if (agent) {
      await log(AGENT_ID, "error", `❌ ${error.message}`, {
        status: "error",
        metadata: { error: error.message, stack: error.stack?.substring(0, 500) },
      });
      await updateAgentState(AGENT_ID, { current_action: "⚠️ Erreur" });
    }
  }
}

// ─── IMAP Polling (remplacement du webhook IMAP) ────────────────────────────

let lastEmailCheck = Date.now();

async function checkNewEmails() {
  try {
    const agent = await loadAgentState(AGENT_ID);
    if (agent.status === "sleeping") return;

    const emails = await fetchRecentEmails(agent, 5);
    if (emails.length > 0) {
      const newEmails = emails.filter(e => new Date(e.date).getTime() > lastEmailCheck);
      if (newEmails.length > 0) {
        console.log(`📬 ${newEmails.length} nouvel(aux) email(s) detecte(s)`);
        lastEmailCheck = Date.now();
        await runCycle("email_received", { count: newEmails.length, latest: newEmails[0] });
      }
    }
  } catch (e) {
    console.warn(`⚠️ Email check failed: ${e.message}`);
  }
}

// ─── Express Webhook Server ─────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check (zero cost)
app.get("/health", async (req, res) => {
  const agent = await loadAgentState(AGENT_ID).catch(() => null);
  res.json({
    status: "ok",
    agent: agent?.name || "unknown",
    agentStatus: agent?.status || "unknown",
    budgetToday: `${rateLimiter.dailyCost.toFixed(2)}¢/${DAILY_BUDGET_CENTS}¢`,
    cyclesThisHour: rateLimiter.cycles.length,
    uptime: process.uptime(),
  });
});

// Webhook: Stripe sale
app.post("/webhook/sale", async (req, res) => {
  console.log(`🔔 Webhook sale recu`);
  await runCycle("sale_detected", req.body);
  res.json({ ok: true });
});

// Webhook: Email notification (si Mailcow webhook configure)
app.post("/webhook/email", async (req, res) => {
  console.log(`🔔 Webhook email recu`);
  await runCycle("email_received", req.body);
  res.json({ ok: true });
});

// Webhook: Manuel depuis le dashboard
app.post("/webhook/manual", async (req, res) => {
  const sig = req.headers["x-webhook-signature"];
  if (WEBHOOK_SECRET !== "auto" && sig) {
    if (!validateWebhookSignature(req.body, sig, WEBHOOK_SECRET)) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  }
  console.log(`🔔 Cycle manuel demande`);
  await runCycle("manual", req.body);
  res.json({ ok: true });
});

// API: Status rapide
app.get("/status", async (req, res) => {
  try {
    const agent = await loadAgentState(AGENT_ID);
    res.json({
      name: agent.name,
      status: agent.status,
      points: agent.points,
      euros: agent.euros_generated,
      current_action: agent.current_action,
      last_cycle: agent.memory?.last_cycle,
      last_event: agent.memory?.last_event,
      budget: { used: rateLimiter.dailyCost.toFixed(2), limit: DAILY_BUDGET_CENTS },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Catch-all securite
app.use((req, res) => {
  res.status(404).json({ error: "Route inconnue" });
});

// ─── Cron Jobs (event-driven) ───────────────────────────────────────────────

function scheduleCrons() {
  // Prospection: 1x/jour a 9h local
  const now = new Date();
  const next9am = new Date(now);
  next9am.setHours(9, 0, 0, 0);
  if (next9am <= now) next9am.setDate(next9am.getDate() + 1);
  const msUntil9am = next9am - now;

  setTimeout(() => {
    runCycle("cron_prospecting");
    // Puis toutes les 24h
    setInterval(() => runCycle("cron_prospecting"), 24 * 60 * 60 * 1000);
  }, msUntil9am);

  console.log(`⏰ Cron prospection: prochain dans ${(msUntil9am / 3600000).toFixed(1)}h`);

  // Check emails: toutes les 15 min (beaucoup moins cher que cycle IA toutes les 4h)
  setInterval(checkNewEmails, 15 * 60 * 1000);
  console.log(`📬 Check emails: toutes les 15 min`);

  // Fallback cron cycle: 1x toutes les 8h (au lieu de 4h — evenements couvrent le reste)
  setInterval(() => runCycle("cron_default"), 8 * 60 * 60 * 1000);
  console.log(`🔄 Fallback cron: toutes les 8h`);
}

// ─── Demarrage ──────────────────────────────────────────────────────────────

async function start() {
  console.log(`\n⚡ EXCELSIOR AGENT RUNTIME v3 — EVENT-DRIVEN`);
  console.log(`Agent ID: ${AGENT_ID}`);
  console.log(`Budget: ${DAILY_BUDGET_CENTS}¢/jour | Rate limit: ${MAX_CYCLES_PER_HOUR}/h`);
  console.log(`Webhook port: ${PORT}`);
  console.log(`Webhook secret: ${WEBHOOK_SECRET === "auto" ? "auto-generated" : "configured"}\n`);

  // Demarrer le serveur webhook
  app.listen(PORT, () => {
    console.log(`🌐 Webhook server: http://0.0.0.0:${PORT}`);
    console.log(`   GET  /health — Health check`);
    console.log(`   GET  /status — Agent status`);
    console.log(`   POST /webhook/sale — Stripe webhook`);
    console.log(`   POST /webhook/email — Email webhook`);
    console.log(`   POST /webhook/manual — Declenchement manuel\n`);
  });

  // Cycle initial
  await runCycle("startup");

  // Programmer les crons
  scheduleCrons();
}

start().catch(console.error);
