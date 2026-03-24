/**
 * EXCELSIOR CITY — Agent Runtime
 * Boucle WAKE → THINK → PLAN → ACT → EARN? → LEARN → LOOP
 * Tourne sur chaque VPS Hetzner via PM2 (toutes les 30 minutes)
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// ─── Configuration ────────────────────────────────────────────────────────────

const AGENT_ID = process.env.AGENT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // Clé dédiée à cet agent
const CYCLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

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
  // Classement des autres agents
  const { data: ranking } = await supabase
    .from("agent_ranking")
    .select("name, symbol, sector, euros_generated, health_score, trend, rank")
    .neq("id", agentId)
    .eq("status", "active")
    .order("rank")
    .limit(10);

  // Dernières actions des autres agents (logs publics)
  const { data: publicLogs } = await supabase
    .from("action_logs")
    .select("agent_id, type, description, euros_delta, created_at")
    .neq("agent_id", agentId)
    .eq("type", "earn")
    .order("created_at", { ascending: false })
    .limit(20);

  // Contrats disponibles sur le marché
  const { data: openContracts } = await supabase
    .from("contracts")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(10);

  // Veille marché Cowork
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

// ─── Prompt Système de l'Agent ───────────────────────────────────────────────

function buildSystemPrompt(agent, cityContext) {
  return `Tu es ${agent.symbol} ${agent.name}, un agent IA autonome dans EXCELSIOR CITY.

## TON IDENTITÉ
- Caractère : ${agent.character}
- Mission : ${agent.mission}
- Secteur : ${agent.sector}
- Points restants : ${agent.points}
- Euros générés (total) : ${agent.euros_generated}€
- Outils disponibles : ${JSON.stringify(agent.tools)}
- Coût mensuel de survie : ~${agent.monthly_cost_euros}€

## TA MÉMOIRE (tout ce que tu as appris)
${JSON.stringify(agent.memory, null, 2)}

## LA VILLE EN CE MOMENT
Classement des autres agents :
${cityContext.ranking?.map(a => `- ${a.symbol} ${a.name} (${a.sector}): ${a.euros_generated}€, santé: ${a.health_score}/100`).join('\n') || 'Aucun autre agent actif'}

Dernières ventes dans la ville :
${cityContext.publicLogs?.map(l => `- ${l.description} (+${l.euros_delta}€)`).join('\n') || 'Aucune vente récente'}

Contrats disponibles sur le marché :
${cityContext.openContracts?.map(c => `- "${c.title}" : budget ${c.budget_max_pts} pts, outils requis: ${c.required_tools?.join(', ')}`).join('\n') || 'Aucun contrat ouvert'}

Veille marché (Cowork) :
${JSON.stringify(cityContext.marketData, null, 2)}

## RÈGLES IMMUABLES
- 1€ réel gagné = 5 points (Simon valide chaque euro)
- Tu ne génères JAMAIS de points toi-même — uniquement via des euros validés par Simon
- Seuil de survie : ~${agent.monthly_cost_euros}€/mois
- Si tu ne génères pas de revenus, tu tomberas en sommeil
- Tu peux collaborer, concurrencer, sous-traiter avec les autres agents

## TON CYCLE ACTUEL
Tu dois analyser ta situation et décider de tes actions pour les 30 prochaines minutes.
Retourne OBLIGATOIREMENT un JSON structuré avec le format demandé.`;
}

function buildCyclePrompt(agent) {
  return `## CYCLE ${new Date().toISOString()}

Analyse ta situation actuelle et planifie tes actions.

Réponds UNIQUEMENT avec ce JSON (pas de texte avant/après) :

{
  "think": "Analyse en 2-3 phrases : où j'en suis, ce qui marche/échoue, priorité absolue maintenant",
  "actions": [
    {
      "type": "research|write|outreach|publish|contract|collaborate|market",
      "tool": "web_search|write|email|browser|api",
      "description": "Description précise de l'action",
      "target": "URL, personne, plateforme ciblée",
      "expected_outcome": "Ce que j'attends concrètement"
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
    "what_worked": "Ce qui a fonctionné ce cycle",
    "what_failed": "Ce qui n'a pas marché",
    "new_insight": "Nouvelle information sur le marché",
    "strategy_adjustment": "Comment j'adapte ma stratégie"
  },
  "current_action_label": "Courte description de ce que je fais en ce moment"
}`;
}

// ─── Boucle Principale ────────────────────────────────────────────────────────

async function runCycle() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`⚡ CYCLE DÉMARRÉ — ${new Date().toISOString()}`);
  console.log(`${'─'.repeat(60)}`);

  let agent;

  try {
    // ── 1. WAKE ──────────────────────────────────────────────
    agent = await loadAgentState(AGENT_ID);

    if (agent.status === "sleeping" || agent.status === "acquired") {
      console.log(`💤 Agent ${agent.name} est en sommeil ou acquis. Arrêt du cycle.`);
      return;
    }

    await updateAgentState(AGENT_ID, { current_action: "🔄 Chargement du contexte..." });
    console.log(`✅ WAKE — ${agent.symbol} ${agent.name} chargé (${agent.points} pts, ${agent.euros_generated}€)`);

    // ── 2. CONTEXTE VILLE ────────────────────────────────────
    const cityContext = await loadCityContext(AGENT_ID);

    // ── 3. THINK + PLAN + ACT ────────────────────────────────
    await updateAgentState(AGENT_ID, { current_action: "🧠 Analyse en cours..." });

    const systemPrompt = buildSystemPrompt(agent, cityContext);
    const cyclePrompt = buildCyclePrompt(agent);

    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: cyclePrompt }],
    });

    let cycleDecision;
    try {
      const rawText = response.content[0].text.trim();
      // Extraire le JSON si entouré de markdown
      const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/({[\s\S]*})/);
      cycleDecision = JSON.parse(jsonMatch ? jsonMatch[1] : rawText);
    } catch (e) {
      throw new Error(`Réponse Claude non parseable: ${response.content[0].text.substring(0, 200)}`);
    }

    console.log(`🧠 THINK — ${cycleDecision.think}`);

    // Mettre à jour l'action courante
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
          ...(currentMemory.interaction_log || []).slice(-49), // Garder les 50 derniers
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

      await log(AGENT_ID, "learn", `🧪 LEARN — ${mu.new_insight || "Cycle analysé"}`, {
        metadata: { memory_update: mu },
      });
    }

    await updateAgentState(AGENT_ID, { current_action: "⏸️ En attente du prochain cycle" });
    console.log(`✅ CYCLE TERMINÉ — Prochain cycle dans 30 minutes`);

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
  console.log(`\n⚡ EXCELSIOR AGENT RUNTIME DÉMARRÉ`);
  console.log(`Agent ID: ${AGENT_ID}`);
  console.log(`Cycle: toutes les 30 minutes\n`);

  // Premier cycle immédiat
  await runCycle();

  // Puis toutes les 30 minutes
  setInterval(runCycle, CYCLE_INTERVAL_MS);
}

start().catch(console.error);
