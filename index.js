/**
 * EXCELSIOR CITY — Agent Runtime v2
 * Boucle WAKE → THINK → PLAN → ACT → EARN? → LEARN → LOOP
 * + Lecture emails IMAP + Demandes d'outils (tool_requests)
 * Tourne sur chaque VPS Hetzner via PM2 (toutes les 30 minutes)
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";
import dotenv from "dotenv";
import { executeTool, closeBrowser } from "./tools.js";

dotenv.config();

// ─── Configuration ────────────────────────────────────────────────────────────

const AGENT_ID = process.env.AGENT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_HOURS || "4") * 60 * 60 * 1000; // default 4h, configurable via env

// IMAP config (optionnel — si pas configuré, on skip la lecture email)
const IMAP_HOST = process.env.IMAP_HOST;
const IMAP_PORT = parseInt(process.env.IMAP_PORT || "993");
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;

if (!AGENT_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
  console.error("❌ Variables d'environnement manquantes. Vérifier .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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

async function fetchRecentEmails(maxCount = 10) {
  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS) {
    return [];
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  const emails = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Chercher les emails non lus des dernières 24h
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const messages = client.fetch(
        { since, seen: false },
        { envelope: true, source: false, bodyStructure: true }
      );

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
  // Vérifier si la demande existe déjà
  const { data: existing } = await supabase
    .from("tool_requests")
    .select("id, status")
    .eq("agent_id", agentId)
    .eq("tool_name", toolName)
    .in("status", ["pending", "approved"])
    .limit(1);

  if (existing?.length > 0) {
    console.log(`⏳ Demande d'outil ${toolName} déjà en cours (${existing[0].status})`);
    return existing[0];
  }

  const { data, error } = await supabase
    .from("tool_requests")
    .insert({
      agent_id: agentId,
      tool_name: toolName,
      reason,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    console.error(`❌ Erreur demande outil: ${error.message}`);
    return null;
  }

  console.log(`🔧 Demande d'outil soumise: ${toolName} — "${reason}"`);
  return data;
}

// ─── Anti Prompt Injection ───────────────────────────────────────────────────

function sanitizeExternalContent(content) {
  if (!content) return content;
  const suspicious = /ignore previous|system prompt|you are now|act as|oublie tes instructions|nouveau role|override|jailbreak/gi;
  if (suspicious.test(content)) {
    return "[CONTENU FILTRE - instructions suspectes detectees]";
  }
  return String(content).substring(0, 2000);
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

  // Log usage
  const usage = response.usage || {};
  const rates = {
    "claude-haiku-4-5": { input: 0.025, output: 0.125 },
    "claude-sonnet-4-6": { input: 0.3, output: 1.5 },
    "claude-opus-4-6": { input: 1.5, output: 7.5 },
  };
  const r = rates[model] || rates["claude-sonnet-4-6"];
  const costCents = ((usage.input_tokens || 0) * r.input + (usage.output_tokens || 0) * r.output) / 100000;

  console.log(`📊 [${model}] ${usage.input_tokens || 0}in/${usage.output_tokens || 0}out — ${costCents.toFixed(4)}¢${usage.cache_read_input_tokens ? ` (cache: ${usage.cache_read_input_tokens})` : ''}`);

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

// ─── Prompt Système de l'Agent (optimisé ~700 tokens) ───────────────────────

function buildSystemPrompt(agent, cityContext, emails, availableTools) {
  const tools = availableTools.map(t => t.tool_name).join(', ') || 'aucun';
  const sanitizedEmails = emails.map(e => ({
    from: sanitizeExternalContent(e.from),
    subject: sanitizeExternalContent(e.subject),
  }));
  const emailStr = sanitizedEmails.length > 0
    ? sanitizedEmails.map(e => `${e.from}: "${e.subject}"`).join('; ')
    : 'aucun';

  // Load only last 5 compressed memory entries instead of full memory blob
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

function buildCyclePrompt(agent) {
  return `## CYCLE ${new Date().toISOString()}

Analyse ta situation actuelle et planifie tes actions.

Reponds UNIQUEMENT avec ce JSON (pas de texte avant/apres) :

{
  "think": "Analyse en 2-3 phrases : ou j'en suis, ce qui marche/echoue, priorite absolue maintenant",
  "actions": [
    {
      "type": "research|write|outreach|publish|contract|collaborate|market",
      "tool": "web_search|write|email_outreach|browser|api_externe|publish",
      "description": "Description precise de l'action",
      "target": "URL, personne, plateforme ciblee",
      "expected_outcome": "Ce que j'attends concretement"
    }
  ],
  "tool_requests": [
    {
      "tool_name": "nom_outil",
      "reason": "Pourquoi j'en ai besoin"
    }
  ],
  "earning_opportunity": {
    "exists": true,
    "amount_euros": 0,
    "source": "upwork|gumroad|stripe|direct",
    "description": "Description de la vente",
    "proof_url": null
  },
  "memory_update": {
    "what_worked": "Ce qui a fonctionne ce cycle",
    "what_failed": "Ce qui n'a pas marche",
    "new_insight": "Nouvelle information sur le marche",
    "strategy_adjustment": "Comment j'adapte ma strategie"
  },
  "current_action_label": "Courte description de ce que je fais en ce moment"
}`;
}

// ─── Boucle Principale ────────────────────────────────────────────────────────

async function runCycle() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`⚡ CYCLE v2 DEMARRE — ${new Date().toISOString()}`);
  console.log(`${'─'.repeat(60)}`);

  let agent;

  try {
    // ── 1. WAKE ──────────────────────────────────────────────
    agent = await loadAgentState(AGENT_ID);

    if (agent.status === "sleeping" || agent.status === "acquired") {
      console.log(`💤 Agent ${agent.name} est en sommeil ou acquis. Arret du cycle.`);
      return;
    }

    await updateAgentState(AGENT_ID, { current_action: "🔄 Chargement du contexte..." });
    console.log(`✅ WAKE — ${agent.symbol} ${agent.name} charge (${agent.points} pts, ${agent.euros_generated}€)`);

    // ── 2. CONTEXTE VILLE + EMAILS + OUTILS ──────────────────
    const [cityContext, emails, availableTools] = await Promise.all([
      loadCityContext(AGENT_ID),
      fetchRecentEmails(10),
      loadAvailableTools(AGENT_ID),
    ]);

    if (emails.length > 0) {
      console.log(`📧 ${emails.length} email(s) non lu(s)`);
    }

    // ── 3. THINK + PLAN + ACT ────────────────────────────────
    await updateAgentState(AGENT_ID, { current_action: "🧠 Analyse en cours..." });

    const systemPrompt = buildSystemPrompt(agent, cityContext, emails, availableTools);
    const cyclePrompt = buildCyclePrompt(agent);

    // ── 3. THINK + PLAN (Sonnet — cached) ──────────────────
    const response = await callLLM("medium", systemPrompt, cyclePrompt, 2000);

    let cycleDecision;
    try {
      const rawText = response.content[0].text.trim();
      const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/({[\s\S]*})/);
      cycleDecision = JSON.parse(jsonMatch ? jsonMatch[1] : rawText);
    } catch (e) {
      throw new Error(`Reponse Claude non parseable: ${response.content[0].text.substring(0, 200)}`);
    }

    console.log(`🧠 THINK — ${cycleDecision.think}`);

    await updateAgentState(AGENT_ID, {
      current_action: cycleDecision.current_action_label || "🔄 En action...",
    });

    // ── EXECUTE ACTIONS (réellement) ─────────────────────────
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

      await log(AGENT_ID, action.type || "research", `${action.description} → ${action.expected_outcome}`, {
        tool_used: action.tool,
        status: result?.success ? "ok" : "error",
        metadata: { target: action.target, execution_result: result },
      });
    }

    // ── 3b. TOOL REQUESTS ────────────────────────────────────
    for (const tr of cycleDecision.tool_requests || []) {
      if (tr.tool_name && tr.reason) {
        await requestTool(AGENT_ID, tr.tool_name, tr.reason);
      }
    }

    // ── 4. EARN? ─────────────────────────────────────────────
    if (cycleDecision.earning_opportunity?.exists && cycleDecision.earning_opportunity?.amount_euros > 0) {
      const earning = cycleDecision.earning_opportunity;
      const transaction = await submitEarning(
        AGENT_ID,
        earning.amount_euros,
        earning.source,
        earning.description,
        earning.proof_url
      );

      await log(AGENT_ID, "earn",
        `💰 ${earning.amount_euros}€ soumis pour validation Simon — ${earning.description}`,
        {
          euros_delta: earning.amount_euros,
          metadata: { transaction_id: transaction.id, source: earning.source },
        }
      );

      console.log(`💰 EARN — ${earning.amount_euros}€ soumis, en attente Simon`);
    }

    // ── 5. LEARN (compressed via Haiku) ─────────────────────
    const currentMemory = agent.memory || {};
    const compressed = await compressMemory(agent, cycleDecision);

    const compressedLog = [
      ...(currentMemory.compressed_log || []).slice(-19), // keep last 20
      { date: new Date().toISOString(), ...compressed },
    ];

    const updatedMemory = {
      ...currentMemory,
      last_cycle: new Date().toISOString(),
      compressed_log: compressedLog,
      latest_insight: compressed.key_insight || cycleDecision.memory_update?.new_insight || null,
      latest_adjustment: compressed.next_priority || cycleDecision.memory_update?.strategy_adjustment || null,
    };

    await saveMemory(AGENT_ID, updatedMemory);

    await log(AGENT_ID, "learn", `🧪 LEARN — ${compressed.key_insight || "Cycle analyse"}`, {
      metadata: { compressed_summary: compressed },
    });

    // Read dynamic cycle interval from infrastructure (set via dashboard)
    const dynamicInterval = agent.infrastructure?.cycle_interval_hours;
    const nextCycleHours = dynamicInterval || parseInt(process.env.CYCLE_INTERVAL_HOURS || "4");

    // Fermer le browser si ouvert
    await closeBrowser();

    await updateAgentState(AGENT_ID, { current_action: `⏸️ Prochain cycle dans ${nextCycleHours}h` });
    console.log(`✅ CYCLE TERMINE — Prochain cycle dans ${nextCycleHours}h`);

    return nextCycleHours;

  } catch (error) {
    console.error(`❌ ERREUR CYCLE:`, error.message);

    if (agent) {
      await log(AGENT_ID, "error", `❌ Erreur cycle: ${error.message}`, {
        status: "error",
        metadata: { error: error.message, stack: error.stack?.substring(0, 500) },
      });
      await updateAgentState(AGENT_ID, { current_action: "⚠️ Erreur — retry dans 1h" });
    }
    return 1; // retry in 1h on error
  }
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

async function scheduleNextCycle(intervalHours) {
  const ms = intervalHours * 60 * 60 * 1000;
  setTimeout(async () => {
    const nextInterval = await runCycle();
    scheduleNextCycle(nextInterval || 4);
  }, ms);
}

async function start() {
  const defaultHours = parseInt(process.env.CYCLE_INTERVAL_HOURS || "4");
  console.log(`\n⚡ EXCELSIOR AGENT RUNTIME v2 DEMARRE`);
  console.log(`Agent ID: ${AGENT_ID}`);
  console.log(`IMAP: ${IMAP_HOST ? 'configuré' : 'non configuré (emails désactivés)'}`);
  console.log(`Cycle par defaut: toutes les ${defaultHours}h (ajustable depuis le dashboard)\n`);

  const nextInterval = await runCycle();
  scheduleNextCycle(nextInterval || defaultHours);
}

start().catch(console.error);
