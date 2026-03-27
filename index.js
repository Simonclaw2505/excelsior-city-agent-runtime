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

dotenv.config();

// ─── Configuration ────────────────────────────────────────────────────────────

const AGENT_ID = process.env.AGENT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CYCLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

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

// ─── Prompt Système de l'Agent ───────────────────────────────────────────────

function buildSystemPrompt(agent, cityContext, emails, availableTools) {
  const emailSection = emails.length > 0
    ? `\n## EMAILS RECUS (dernières 24h)\n${emails.map(e => `- De: ${e.from} | Sujet: "${e.subject}" | Date: ${e.date}`).join('\n')}`
    : '\n## EMAILS\nAucun email récent.';

  const toolsSection = availableTools.length > 0
    ? `\n## OUTILS ACTIFS\n${availableTools.map(t => `- ${t.tool_name} (actif depuis ${t.granted_at})`).join('\n')}`
    : '\n## OUTILS ACTIFS\nAucun outil spécifique activé. Tu peux en demander via tool_request.';

  return `Tu es ${agent.symbol} ${agent.name}, un agent IA autonome dans EXCELSIOR CITY.

## TON IDENTITE
- Caractere : ${agent.character}
- Mission : ${agent.mission}
- Secteur : ${agent.sector}
- Points restants : ${agent.points}
- Euros generes (total) : ${agent.euros_generated}€
- Outils declares : ${JSON.stringify(agent.tools)}
- Cout mensuel de survie : ~${agent.monthly_cost_euros}€
${toolsSection}
${emailSection}

## TA MEMOIRE (tout ce que tu as appris)
${JSON.stringify(agent.memory, null, 2)}

## LA VILLE EN CE MOMENT
Classement des autres agents :
${cityContext.ranking?.map(a => `- ${a.symbol} ${a.name} (${a.sector}): ${a.euros_generated}€, sante: ${a.health_score}/100`).join('\n') || 'Aucun autre agent actif'}

Dernieres ventes dans la ville :
${cityContext.publicLogs?.map(l => `- ${l.description} (+${l.euros_delta}€)`).join('\n') || 'Aucune vente recente'}

Contrats disponibles sur le marche :
${cityContext.openContracts?.map(c => `- "${c.title}" : budget ${c.budget_max_pts} pts, outils requis: ${c.required_tools?.join(', ')}`).join('\n') || 'Aucun contrat ouvert'}

Veille marche (Cowork) :
${JSON.stringify(cityContext.marketData, null, 2)}

## REGLES IMMUABLES
- 1€ reel gagne = 5 points (Simon valide chaque euro)
- Tu ne generes JAMAIS de points toi-meme — uniquement via des euros valides par Simon
- Seuil de survie : ~${agent.monthly_cost_euros}€/mois
- Si tu ne generes pas de revenus, tu tomberas en sommeil
- Tu peux collaborer, concurrencer, sous-traiter avec les autres agents
- Pour demander un outil, ajoute une entree "tool_requests" dans ta reponse JSON

## TON CYCLE ACTUEL
Tu dois analyser ta situation et decider de tes actions pour les 30 prochaines minutes.
Retourne OBLIGATOIREMENT un JSON structure avec le format demande.`;
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

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: cyclePrompt }],
    });

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

    // Logger les actions planifiées
    for (const action of cycleDecision.actions || []) {
      await log(AGENT_ID, action.type || "research", `${action.description} → ${action.expected_outcome}`, {
        tool_used: action.tool,
        metadata: { target: action.target },
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

    // ── 5. LEARN ─────────────────────────────────────────────
    if (cycleDecision.memory_update) {
      const mu = cycleDecision.memory_update;
      const currentMemory = agent.memory || {};

      const updatedMemory = {
        ...currentMemory,
        last_cycle: new Date().toISOString(),
        strategy_scores: {
          content: (currentMemory.strategy_scores?.content || 5),
          prospecting: (currentMemory.strategy_scores?.prospecting || 5),
          closing: (currentMemory.strategy_scores?.closing || 5),
          retention: (currentMemory.strategy_scores?.retention || 5),
        },
        interaction_log: [
          ...(currentMemory.interaction_log || []).slice(-49),
          {
            date: new Date().toISOString(),
            worked: mu.what_worked,
            failed: mu.what_failed,
            insight: mu.new_insight,
            adjustment: mu.strategy_adjustment,
          },
        ],
        latest_insight: mu.new_insight,
        latest_adjustment: mu.strategy_adjustment,
      };

      await saveMemory(AGENT_ID, updatedMemory);

      await log(AGENT_ID, "learn", `🧪 LEARN — ${mu.new_insight || "Cycle analyse"}`, {
        metadata: { memory_update: mu },
      });
    }

    await updateAgentState(AGENT_ID, { current_action: "⏸️ En attente du prochain cycle" });
    console.log(`✅ CYCLE TERMINE — Prochain cycle dans 30 minutes`);

  } catch (error) {
    console.error(`❌ ERREUR CYCLE:`, error.message);

    if (agent) {
      await log(AGENT_ID, "error", `❌ Erreur cycle: ${error.message}`, {
        status: "error",
        metadata: { error: error.message, stack: error.stack?.substring(0, 500) },
      });
      await updateAgentState(AGENT_ID, { current_action: "⚠️ Erreur — retry dans 30min" });
    }
  }
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

async function start() {
  console.log(`\n⚡ EXCELSIOR AGENT RUNTIME v2 DEMARRE`);
  console.log(`Agent ID: ${AGENT_ID}`);
  console.log(`IMAP: ${IMAP_HOST ? 'configuré' : 'non configuré (emails désactivés)'}`);
  console.log(`Cycle: toutes les 30 minutes\n`);

  await runCycle();
  setInterval(runCycle, CYCLE_INTERVAL_MS);
}

start().catch(console.error);
