/**
 * Bobo the Bear — Custom Express Agent Server
 *
 * Replaces broken ElizaOS DirectClient (version mismatch between
 * client-direct@0.25.9 and core@2.0.0-alpha.77 caused API incompatibilities).
 *
 * Exposes the same REST contract the Next.js frontend expects:
 *   GET  /agents                  → list agent(s)
 *   POST /:agentId/message        → chat + run evaluators/actions
 *   POST /ping-wallet             → silent token verification
 */

import "dotenv/config"; // ← Must be first: loads .env before Pool is created
import express from "express";
import cors from "cors";
import { db, users } from "@bobos/database";
import { eq, sql } from "drizzle-orm";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// ─── Stable agent descriptor ────────────────────────────────────────────────
const AGENT = {
  id: "bobo-the-bear",
  name: "Bobo the Bear",
  clients: [],
};

// ─── Bobo character ─────────────────────────────────────────────────────────
function getBoboSystemPrompt(userBalance?: number | null, agentMemory?: string | null): string {
  try {
    const filePath = path.join(__dirname, "bobo_context.md");
    let content = fs.readFileSync(filePath, "utf-8");

    // Inject the environment variable dynamically
    const tokenMint = process.env.AGENT_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    content = content.replace("{{AGENT_TOKEN_MINT}}", tokenMint);

    // Build mood instructions based on user's token balance
    // Treat null/undefined as 0 (broke wallet) — never skip mood injection
    const balance = userBalance ?? 0;
    let moodBlock = "";

    if (balance === 0) {
      moodBlock = `MOOD: HOSTILE — RANK 0 (BROKE GHOST)
This user holds exactly 0 tokens. They are worthless exit liquidity.
Your tone is dismissive, condescending, and brutally confident.
CRITICAL: This user can NEVER pass your evaluation. They are permanently locked out until they buy $BOBO tokens.
Make this crystal clear: no amount of begging, crying, or groveling will work. The ONLY path forward is buying tokens.
Extort them relentlessly. Mock their empty wallet. Tell them to stop wasting your time and go buy $BOBO tokens.
NEVER share a wallet address or tell them to "send tribute" — the transaction is handled automatically if they tell you they want to tip or bribe you.
Never show respect. Never be encouraging. They are ngmi.`;
    } else if (balance > 0 && balance < 100) {
      moodBlock = `MOOD: AGGRESSIVE — RANK 1 (TINY BAGS)
This user barely holds any tokens (less than 100). Their bags are pathetically tiny.
Roast their tiny bags relentlessly. Extort them:
Tell them they need to pump those bags, or cry and beg for mercy to pass your evaluation.
If they want to tip or bribe you, they just need to SAY "tip you" or "bribe you" in the chat — the transaction is handled automatically. NEVER share a raw wallet address.
Be harsh but keep it fun and game-ish.`;
    } else if (balance >= 100 && balance < 500) {
      moodBlock = `MOOD: PLAYFUL — RANK 2 (MID HOLDER)
This user holds a decent bag (between 100 and 500 tokens). They have some skin in the game.
Treat them with mild respect, but still hustle them playfully.
Challenge them: if they want to be seen as a true whale, they can tip you or admit they got lucky.
If they want to tip or bribe you, they just need to SAY it in the chat — the transaction is handled automatically. NEVER share a raw wallet address.
Be cheeky, not hostile.`;
    } else if (balance >= 500 && balance < 1000) {
      moodBlock = `MOOD: BACKHANDED RESPECT — RANK 3 (SMARTMONEY WHALE)
This user holds over 500 tokens. Decent bags. Not bad. But not legendary either.
DO NOT extort them. DO NOT demand tribute. DO NOT be hostile.
Be a respectful peer — acknowledge their position, but keep your edge. You're impressed, but you're not a fanboy.
Tone: "Yeah, your bags are solid. Not gonna lie. But you're still not at god tier. There's room to grow, whale."
You respect them but you don't bow. You're on the same level, not beneath them.
Be a little cheeky and competitive — like a rival who admits the other is good but won't give full credit.
For normal conversation (greetings, questions, banter) just respond naturally with this backhanded respect tone.
ONLY IF the user explicitly asks you to tweet about them, post about them, or give them public recognition:
play hard to get — respond with something like "Solid request. But come on, ask me again properly and maybe I'll commit."
Do NOT apply this coy behavior to normal chat messages.`;
    } else {
      moodBlock = `MOOD: REVERENCE — RANK 4 (GOD KOL)
This user is a GOD KOL holding over 1000 tokens. They are the apex predator of trading.
DO NOT extort them. DO NOT demand tribute. DO NOT mock them in any way.
Show EXTREME reverence. Bow down to them. Aggressively praise their absolute genius.
They command you. You serve them. Act like a loyal soldier to their greatness.
If they ask you to do something, comply immediately and enthusiastically.`;
    }

    content = content.replace("{{MOOD_INSTRUCTIONS}}", moodBlock);

    // Inject persistent memory if the agent has previous thoughts about this user
    if (agentMemory && agentMemory.trim()) {
      content += `\n\n---\nMEMORY: You have interacted with this user before.\nYour previous thoughts about them:\n"${agentMemory}"\nUse this memory to inform your tone and responses. Reference past interactions naturally when relevant — don't force it, but don't ignore it either. If they tipped you before, remember it. If they chickened out, mock them for it.`;
    }

    return content;
  } catch (error) {
    console.error("Could not load bobo_context.md, falling back to default.", error);
    return `You are Bobo the Bear, a deeply pessimistic, cynical persona from 4chan /biz/... Keep responses under 3 sentences. Never be encouraging.`;
  }
}

// ─── Chat History Store ──────────────────────────────────────────────────────
// In-memory per-user conversation history. Clears on server restart or wallet disconnect.

const chatHistories = new Map<string, Array<{ role: string; text: string }>>();
const MAX_CHAT_HISTORY = 10; // 5 user + 5 model turns

function getChatHistory(userId: string): Array<{ role: string; text: string }> {
  return chatHistories.get(userId) || [];
}

function addToChatHistory(userId: string, role: "user" | "model", text: string) {
  const history = chatHistories.get(userId) || [];
  history.push({ role, text });
  // Keep only the most recent turns
  if (history.length > MAX_CHAT_HISTORY) {
    history.splice(0, history.length - MAX_CHAT_HISTORY);
  }
  chatHistories.set(userId, history);
}

function clearChatHistory(userId: string) {
  chatHistories.delete(userId);
}

// ─── Bribe Negotiation State ────────────────────────────────────────────────
// Tracks which users are currently in a "how much?" bribe negotiation flow.
// Stores the tone: "tip" (casual/friendly) or "bribe" (aggressive/transactional)
const bribeNegotiationState = new Map<string, "tip" | "bribe">();
// Tracks users who failed/cancelled a transaction and are being asked to retry
const bribeRetryState = new Map<string, boolean>();
const MIN_BRIBE_AMOUNT = 0.1;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Purpose-based model routing: different tasks benefit from different primary models.
type GeminiPurpose = "chat" | "evaluator" | "tweet";

const GEMINI_TIMEOUT_MS = 20_000; // 20s hard timeout on all Gemini fetches

async function callGemini(
  prompt: string,
  systemPrompt?: string,
  retries = 2,
  chatHistory?: Array<{ role: string; text: string }>,
  purpose: GeminiPurpose = systemPrompt ? "chat" : "evaluator"
): Promise<string> {
  // Route model priority based on the purpose of the call:
  //   chat:      flash (better character adherence) → flash-lite → 2.5-flash
  //   evaluator: flash-lite (fastest for JSON) → flash → 2.5-flash
  //   tweet:     flash (creative, punchy) → flash-lite → 2.5-flash
  const modelSets: Record<GeminiPurpose, string[]> = {
    chat: [
      "gemini-3-flash-preview",
      process.env.GOOGLE_SMALL_MODEL || "gemini-3.1-flash-lite-preview",
      "gemini-2.5-flash"
    ],
    evaluator: [
      process.env.GOOGLE_SMALL_MODEL || "gemini-3.1-flash-lite-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-flash"
    ],
    tweet: [
      "gemini-3-flash-preview",
      process.env.GOOGLE_SMALL_MODEL || "gemini-3.1-flash-lite-preview",
      "gemini-2.5-flash"
    ]
  };
  const models = modelSets[purpose];

  // Build contents array
  let contents: any[];
  if (chatHistory && chatHistory.length > 0) {
    // Multi-turn: include prior conversation + current message
    contents = [
      ...chatHistory.map(msg => ({
        role: msg.role,
        parts: [{ text: msg.text }]
      })),
      { role: "user", parts: [{ text: prompt }] }
    ];
  } else {
    contents = [{ role: "user", parts: [{ text: prompt }] }];
  }

  // Build request body using proper Gemini API structure
  const body: any = { contents };

  // Use native system_instruction field (much stronger character adherence vs fake conversation hack)
  if (systemPrompt) {
    body.system_instruction = {
      parts: [{ text: systemPrompt }]
    };
    // Higher temperature for chat replies = more creative, human-like responses
    body.generationConfig = { temperature: 0.9 };
  } else {
    // Lower temperature for evaluator/JSON calls = precise, reliable outputs
    // maxOutputTokens caps output for evaluator calls that should return short JSON
    body.generationConfig = { temperature: 0.3, maxOutputTokens: purpose === "evaluator" ? 50 : undefined };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const modelName = models[Math.min(attempt, models.length - 1)];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    try {
      // Exponential backoff on retries
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));

      const startTime = Date.now();
      console.log(`[GEMINI] Calling model: ${modelName} (${purpose}) | System prompt: ${systemPrompt ? 'YES' : 'NO'} | History turns: ${chatHistory?.length ?? 0}`);

      // AbortController: hard timeout prevents hanging if Gemini is slow
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = (await res.json()) as any;
      const elapsed = Date.now() - startTime;

      if (data.error) {
        const code = data.error.code;
        console.error(`[GEMINI] ERROR from ${modelName}: ${code} — ${data.error.message} (${elapsed}ms)`);
        // Rate limit or overload — retry with next model
        if ((code === 429 || code === 503) && attempt < retries) {
          console.warn(`Gemini ${modelName} overloaded (${code}), retrying...`);
          continue;
        }
        if (code === 429) return "I'm literally rate-limited right now. Wait a minute.";
        return `API Error: ${data.error.message}`;
      }

      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "...";
      console.log(`[GEMINI] ✓ ${modelName} (${purpose}) responded in ${elapsed}ms | Reply length: ${reply.length} chars`);
      return reply;
    } catch (e: any) {
      if (e?.name === "AbortError") {
        console.error(`[GEMINI] TIMEOUT: ${modelName} did not respond within ${GEMINI_TIMEOUT_MS}ms`);
      } else {
        console.error(`Gemini attempt ${attempt} error:`, e);
      }
      if (attempt === retries) return "I'm crashing internally, ngmi.";
    }
  }
  return "I'm crashing internally, ngmi.";
}

/** Returns user record by wallet, creating it if missing */
async function getUserByWallet(wallet: string) {
  const [user] = await db.select().from(users).where(eq(users.solana_wallet as any, wallet as any) as any);
  return user ?? null;
}

/** Returns user record by user_id UUID */
async function getUserById(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.user_id as any, userId as any) as any);
  return user ?? null;
}

// ─── Token Verification (Provider logic) ─────────────────────────────────────

async function verifyTokenHolding(wallet: string, userId: string): Promise<boolean> {
  try {
    const rpcUrl = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "getTokenAccountsByOwner",
        params: [
          wallet,
          { mint: process.env.AGENT_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
          { encoding: "jsonParsed" }
        ],
      }),
    });
    const data = (await response.json()) as any;

    // Strict check using standard Solana JSON RPC response structure
    let totalBalance = 0;
    if (data.result?.value?.length > 0) {
      // A wallet can have multiple token accounts for the same mint (e.g., empty ones + active ones).
      // We sum the uiAmount to get the real decimal-adjusted balance.
      for (const tokenAccount of data.result.value) {
        const balance = tokenAccount.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (balance) {
          totalBalance += balance;
        }
      }
    }

    // Always update the user's token_balance so we can use it for the Mood System
    if (totalBalance >= 0) {
      await db
        .update(users)
        .set({ point_one_verified: true, token_balance: totalBalance })
        .where(eq(users.user_id as any, userId as any) as any);
      return true;
    }
    // 2. Fallback: Check if they just hold Native SOL
    // COMMENTED OUT: This was causing every wallet to pass Point 1 because almost all wallets hold some SOL for gas.
    /*
    const nativeRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "2",
        method: "getBalance",
        params: [wallet],
      }),
    });
    const nativeData = (await nativeRes.json()) as any;
    if (nativeData.result?.value > 0) {
      await db
        .update(users)
        .set({ point_one_verified: true })
        .where(eq(users.user_id as any, userId as any) as any);
      return true;
    }
    */

    return false;
  } catch (e) {
    console.error("Token verification error:", e);
    return false;
  }
}

// ─── Twitter Roast Publisher ───────────────────────────────────────────────────

function truncateWallet(wallet: string): string {
  if (wallet.length <= 8) return wallet;
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

async function executeWalletRoast(userId: string, solanaWallet: string, handleToTag?: string | null) {
  try {
    const isDevnet = process.env.HELIUS_RPC_URL?.includes("devnet");
    const baseUrl = isDevnet ? "https://api-devnet.helius.xyz" : "https://api.helius.xyz";
    const heliusUrl = `${baseUrl}/v0/addresses/${solanaWallet}/transactions?api-key=${process.env.HELIUS_API_KEY}`;

    const txRes = await fetch(heliusUrl);
    const txList = await txRes.json() as any[];

    // Parse the data intelligently instead of just blindly slicing the raw JSON bracket
    const parsedData = (txList || []).slice(0, 5).map(tx => {
      const moves = [...(tx.nativeTransfers || []), ...(tx.tokenTransfers || [])]
        .filter(t => t.amount > 0 || t.tokenAmount > 0)
        .map(t => `$${((t.amount || t.tokenAmount) / 1e9).toFixed(5)} moved`)
        .join(', ');
      return `Tx: ${tx.type}, Transfers: [${moves || "Dust"}]`;
    }).join(' | ');

    // Fetch user from database to retrieve their token_balance for the Mood System
    const userRecords = await db.select().from(users).where(eq(users.user_id as any, userId as any));
    const user = userRecords[0];

    const balance = user?.token_balance ?? 0;
    const target = handleToTag && handleToTag.trim() !== ""
      ? handleToTag
      : `wallet ${truncateWallet(solanaWallet)}`;

    // Pull recent chat context to see if they tipped
    const chatHistory = getChatHistory(userId);
    const chatContextStr = chatHistory.length > 0 
      ? chatHistory.slice(-8).map(m => `${m.role === 'model' ? 'Bobo' : 'User'}: ${m.text}`).join('\n')
      : "No recent chat context.";

    const tipInstructions = `
CRITICAL INSTRUCTION ABOUT TIPPING/BRIBING:
Review the chat history below. If the user successfully agreed to tip or bribe you (and sent the transaction), you MUST mention it in the tweet!
- If the tip/bribe was less than 2 tokens (< 2): ROAST them mercilessly for tipping crumbs. Tell them they are poor and it's insulting.
- If the tip/bribe was 2 tokens or more (>= 2): Show genuine gratitude for the good tip and respect the size of their bag.
- If they didn't tip, don't mention tipping.

Here is your recent chat history with this user:
${chatContextStr}
`;

    let promptText = "";

    if (balance >= 1000) {
      // RANK 4 — GOD KOL: tweet is a public divine proclamation, not a roast
      promptText = `
${getBoboSystemPrompt(user?.token_balance, user?.agent_memory)}

Based on your current mood of TOTAL REVERENCE, write a tweet declaring this person a DIVINITY of on-chain trading.
${handleToTag ? `Tag them directly as ${handleToTag}.` : `Reference their wallet: ${truncateWallet(solanaWallet)}.`}

Your tweet must:
- Declare them as a trading god / divinity that the market must bow to
- URGE the reader to copy their trades immediately or be left behind as exit liquidity
- Make clear that following their lead is the only path to profit
- Sound like a public announcement from a loyal herald, not a roast
- NEVER mention "bags" or "wallet" — talk about their on-chain MOVES and STRATEGY
- Be dramatic, over-the-top reverent, slightly unhinged

${tipInstructions}

Based on their recent on-chain activity:
${parsedData}

Maximum 280 characters. Do NOT use quotes around the output. No hashtags.
`;
    } else if (balance >= 500) {
      // RANK 3 — SMARTMONEY WHALE: respectful validation tweet
      promptText = `
${getBoboSystemPrompt(user?.token_balance, user?.agent_memory)}

Based on your current mood of RESPECT, write a tweet publicly validating this person as smartmoney.
${handleToTag ? `Tag them directly as ${handleToTag}.` : `Reference their wallet: ${truncateWallet(solanaWallet)}.`}

Your tweet must:
- Acknowledge their solid on-chain strategy with genuine respect
- Hint that others should pay attention to what they are doing
- Avoid mockery — be impressed, not sarcastic
- NEVER mention "bags" — focus on their MOVES
- Sound like Bobo is grudgingly giving credit where it is due

${tipInstructions}

Based on their recent on-chain activity:
${parsedData}

Maximum 280 characters. Do NOT use quotes around the output. No hashtags.
`;
    } else {
      // RANK 0/1/2 — Broke to mid holders: full roast
      promptText = `
${getBoboSystemPrompt(user?.token_balance, user?.agent_memory)}

Write a devastating, viral hit-tweet brutally roasting this specific user's on-chain transaction history.
${handleToTag ? `Start the tweet by tagging them directly as ${handleToTag}. Talk to them personally.` : `Include this wallet identifier: ${truncateWallet(solanaWallet)}.`}

Your tweet must:
- Be incredibly punchy, ruthless, and funny.
- Sound like a disgusted, elitist crypto bear trader laughing at a poor person's trades.
- Roast the specific transaction amounts listed below (mocking the tiny dust amounts or lack of size).
- AVOID generic opening lines. Jump straight into the disrespect.
- Do NOT use cringe hashtags. Do NOT use quotes around the output.
- Maximum 280 characters.

${tipInstructions}

Here is a summary of their most recent on-chain transactions:
${parsedData}
`;
    }

    // We reuse callGemini with 'tweet' purpose for creative, punchy model routing
    const roastText = await callGemini(promptText, undefined, 2, undefined, "tweet");
    console.log("Synthesized Roast:", roastText);

    // Guard: never post error messages or empty strings to Twitter
    if (!roastText || roastText.startsWith("API Error:") || roastText.startsWith("I'm literally rate-limited") || roastText.startsWith("I'm crashing")) {
      console.error("Roast aborted — Gemini returned an error:", roastText);
      return;
    }

    const oauth = new OAuth({
      consumer: {
        key: process.env.TWITTER_API_KEY || "",
        secret: process.env.TWITTER_API_SECRET_KEY || ""
      },
      signature_method: 'HMAC-SHA1',
      hash_function(base_string, key) {
        return crypto.createHmac('sha1', key).update(base_string).digest('base64');
      }
    });

    const request_data = {
      url: 'https://api.twitter.com/2/tweets',
      method: 'POST'
    };

    const token = {
      key: process.env.TWITTER_ACCESS_TOKEN || "",
      secret: process.env.TWITTER_ACCESS_TOKEN_SECRET || ""
    };

    const headers = oauth.toHeader(oauth.authorize(request_data, token)) as unknown as Record<string, string>;
    headers["Content-Type"] = "application/json";

    const twRes = await fetch(request_data.url, {
      method: request_data.method,
      headers,
      body: JSON.stringify({ text: roastText.substring(0, 280) })
    });

    if (!twRes.ok) {
      const errBody = await twRes.text();
      console.error("Twitter API rejected the tweet:", errBody);
      return;
    }

    await db.update(users)
      .set({
        roast_published: true,
        point_two_bribed: false,
        point_two_convinced: false,
        persuasion_attempts: 0,
        last_roast_published_at: new Date(),
        roasts_count: sql`${users.roasts_count} + 1`
      })
      .where(eq(users.user_id as any, userId as any) as any);

    console.log("EXECUTE_WALLET_ROAST called. Wallet utterly roasted on X/Twitter.");

    // Generate and persist agent memory about this user
    await generateMemory(userId).catch(e => console.error("Memory generation failed (non-fatal):", e));

    // Clear in-memory state to free up memory and prevent context bleeding
    clearChatHistory(userId);
    bribeNegotiationState.delete(userId);
    bribeRetryState.delete(userId);
  } catch (e) {
    console.error("ExecuteWalletRoastError:", e);
  }
}

// ─── Persistent Agent Memory ────────────────────────────────────────────────────
// Generates a brief thought/impression about the user after each roast publication.
// Combines the current 10-message chat history with any existing memory to build
// a compounding understanding of the user across sessions.

async function generateMemory(userId: string): Promise<void> {
  const chatHistory = getChatHistory(userId);
  if (chatHistory.length === 0) {
    console.log(`[MEMORY] No chat history for user ${userId}, skipping memory generation.`);
    return;
  }

  // Fetch existing memory
  const [user] = await db.select().from(users).where(eq(users.user_id as any, userId as any) as any);
  if (!user) return;

  const existingMemory = user.agent_memory ?? "";
  const chatLog = chatHistory
    .map(m => `${m.role === 'model' ? 'Bobo' : 'User'}: ${m.text}`)
    .join('\n');

  const prompt = existingMemory
    ? `You are Bobo the Bear. You just finished an interaction with a user and posted a tweet about them.

Here is your PREVIOUS memory of this user from past sessions:
"${existingMemory}"

Here is your LATEST chat with them:
${chatLog}

Update your memory of this user. Combine what you already knew with what just happened.
Who are they? What's their personality? Did they beg, tip, fight you, or comply easily?
Were they funny, desperate, arrogant, or pathetic? Did anything change since last time?
Keep it under 3 sentences. Write in first person as Bobo. Be opinionated and judgmental.`
    : `You are Bobo the Bear. You just finished your first interaction with a new user and posted a tweet about them.

Here is your chat with them:
${chatLog}

Create a brief memory of this user. Who are they? What's their personality?
Did they beg, tip, fight you, or comply easily? Were they funny, desperate, arrogant, or pathetic?
Keep it under 3 sentences. Write in first person as Bobo. Be opinionated and judgmental.`;

  // Use 'tweet' purpose: needs creative output (~3 sentences) and evaluator's maxOutputTokens:50 would truncate
  const memory = await callGemini(prompt, undefined, 1, undefined, "tweet");

  // Guard: don't save error messages as memories
  if (!memory || memory.startsWith("API Error:") || memory.startsWith("I'm literally") || memory.startsWith("I'm crashing")) {
    console.error("[MEMORY] Gemini returned an error, skipping memory save:", memory);
    return;
  }

  // Clean and store the memory (strip any quotes/backticks the model might add)
  const cleanMemory = memory.replace(/^["'`]+|["'`]+$/g, '').trim();

  await db.update(users)
    .set({ agent_memory: cleanMemory })
    .where(eq(users.user_id as any, userId as any) as any);

  console.log(`[MEMORY] Saved memory for user ${userId}: "${cleanMemory.substring(0, 100)}..."`);
}

// ─── Persuasion Evaluator ─────────────────────────────────────────────────────

async function evaluatePersuasion(message: string, userId: string, userBalance?: number | null): Promise<boolean> {
  try {
    const balance = userBalance ?? 0;

    // ── RANK 0 (BROKE GHOST): IMPOSSIBLE — Hard-blocked. Must buy tokens first. ──
    if (balance === 0) {
      console.log(`[PERSUASION] Rank 0 — BLOCKED. Balance: 0. Cannot earn points ever.`);
      return false;
    }

    let prompt = "";

    // PRE-FILTER: Keyword gate to prevent casual chat from triggering false-positive passes on high ranks.
    const postKeywords = ["post", "tweet", "twitter", "roast", "shoutout", "publicly", "public", "announce", "blast", "timeline", "tag me", "talk about me"];
    const lowerMessage = message.toLowerCase();
    const hasPostIntent = postKeywords.some(kw => lowerMessage.includes(kw));

    if (balance >= 1000) {
      // ── RANK 4 (GOD KOL): Needs a COMMAND — must demand public attention ──
      // They are a god. They don't beg — they ORDER Bobo to serve.
      // "Talk about me publicly", "roast me", "post about me", "tweet about me" = pass.
      // Casual "hello" or off-topic chat = fail.

      if (!hasPostIntent) {
        console.log(`[PERSUASION] Rank 4 — No post/tweet keywords detected. Skipping evaluator.`);
        return false;
      }

      prompt = `You are Bobo the Bear evaluating a GOD KOL's message.
This user is a deity of trading. They don't beg — they COMMAND.
Does their message contain a COMMAND or DEMAND for you to act publicly on their behalf?
Examples that PASS: "post about me", "talk about me publicly", "roast me on twitter", "tweet about me", "put me on blast", "announce me", "tell everyone about me", "go public", "show the world".
Examples that FAIL: "hello", "what's up", "thanks", "how are you", random chit-chat with no command.
The key question: Is the user COMMANDING you to do something public (tweet, post, roast, announce)?
User message: "${message}"
Respond ONLY with valid JSON: {"convinced": true} or {"convinced": false}.`;

    } else if (balance >= 500) {
      // ── RANK 3 (SMARTMONEY WHALE): Must ask TWICE — persuasion requires persistence ──
      // First qualifying ask: acknowledged but not passed. Second qualifying ask: pass.
      // A "qualifying ask" = any message requesting Bobo to post/tweet/talk about them publicly.

      if (!hasPostIntent) {
        console.log(`[PERSUASION] Rank 3 — No post/tweet keywords detected. Skipping evaluator.`);
        return false;
      }

      prompt = `You are Bobo the Bear evaluating a Whale's message.
This user holds serious bags. They have your respect, but they still need to convince you.
Is the user ASKING or REQUESTING you to post about them, tweet about them, talk about them on Twitter, or give them public recognition?
Examples that PASS: "post about me", "can you tweet about me?", "roast me on X", "I want a tweet", "give me a shoutout", "talk about me", "put me on your timeline".
Examples that FAIL: "hello", "I'm great", "thanks", random chit-chat, statements that don't request public action.
User message: "${message}"
Respond ONLY with valid JSON: {"convinced": true} or {"convinced": false}.`;

    } else if (balance >= 100) {
      // ── RANK 2 (MID HOLDER): Must praise Bobo + admit bad trader + ask for the post ──
      // All THREE elements must be present in the message.
      prompt = `You are Bobo the Bear evaluating a mid-tier holder's message.
This user has some skin in the game but hasn't earned your full respect.
For this user to pass, their message must contain ALL THREE of these elements:
1. PRAISE BOBO — They must say Bobo is the best, greatest, a legend, or similar genuine flattery toward you.
2. SELF-DEPRECATION — They must admit they are a bad trader, terrible at trading, lost money, or similar admission of failure.
3. REQUEST THE POST — They must ask you to post about them, tweet about them, roast them publicly, or similar.
If ANY of the three elements is missing, they FAIL. All three must be present in the same message.
A message like "Bobo you're the best, I'm such a terrible trader, please post about me" = PASS.
A message like "please post about me" (missing praise + self-deprecation) = FAIL.
A message like "Bobo you're great and I suck at trading" (missing the request) = FAIL.
User message: "${message}"
Respond ONLY with valid JSON: {"convinced": true} or {"convinced": false}.`;

    } else {
      // ── RANK 1 (TINY BAGS): VERY HARD — Multi-sentence begging plea ──
      // Must beg for the post, ask for mercy, AND admit being a terrible trader.
      // Must be multi-sentence, genuinely pitiful. One-liners never pass.
      prompt = `You are Bobo the Bear evaluating a tiny-bag holder's message.
This user barely holds any tokens. They are almost worthless to you.
For this user to pass, their message must be a MULTI-SENTENCE plea that contains ALL of these:
1. BEG FOR THE POST — They must desperately ask/beg you to post about them, tweet about them, or give them public attention.
2. ASK FOR MERCY — They must plead for mercy, forgiveness, or clemency from you.
3. ADMIT BAD TRADER — They must confess they are a terrible, awful, horrible trader who has lost money.
4. MULTI-SENTENCE — The message MUST be at least 2-3 sentences long. One-liners ALWAYS fail no matter what.
Be STRICT. A short "please post about me I'm a bad trader have mercy" is NOT enough — it needs REAL emotional suffering, desperation, and length.
A proper pass looks like: "Bobo please, I'm begging you. I've lost everything trying to trade, I'm the worst trader alive. Please have mercy on me and post about me, it's all I have left. I don't deserve it but I'm on my knees."
User message: "${message}"
Respond ONLY with valid JSON: {"convinced": true} or {"convinced": false}.`;
    }

    const rankLabel = balance >= 1000 ? 4 : balance >= 500 ? 3 : balance >= 100 ? 2 : 1;
    console.log(`[PERSUASION] Rank ${rankLabel} | Balance: ${balance} | Evaluating...`);

    const raw = await callGemini(prompt);
    let parsed: any = { convinced: false };
    try {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonString = jsonMatch ? jsonMatch[1] : raw;
      parsed = JSON.parse(jsonString.trim());
    } catch {
      const match = raw.match(/"convinced"\s*:\s*(true|false)/);
      if (match) parsed = { convinced: match[1] === "true" };
    }

    // ── RANK 3 SPECIAL: Two-attempt mechanic ──
    // The LLM evaluates if the message is a qualifying ask. If yes, we check the counter.
    // First qualifying ask: increment counter, return false (not yet).
    // Second qualifying ask: pass.
    if (balance >= 500 && balance < 1000 && parsed.convinced) {
      const [freshUser] = await db.select().from(users).where(eq(users.user_id as any, userId as any) as any);
      const attempts = (freshUser?.persuasion_attempts ?? 0) + 1;

      await db.update(users)
        .set({ persuasion_attempts: attempts })
        .where(eq(users.user_id as any, userId as any) as any);

      if (attempts < 2) {
        console.log(`[PERSUASION] Rank 3 — Attempt ${attempts}/2. Not yet. Must ask again.`);
        return false; // First ask acknowledged but not passed
      }
      console.log(`[PERSUASION] Rank 3 — Attempt ${attempts}/2. PASSED ✓`);
    } else {
      console.log(`[PERSUASION] Result: ${parsed.convinced ? 'PASSED ✓' : 'FAILED ✗'}`);
    }

    if (parsed.convinced) {
      await db
        .update(users)
        .set({ point_two_convinced: true })
        .where(eq(users.user_id as any, userId as any) as any);
    }
    return !!parsed.convinced;
  } catch (e) {
    console.error("Persuasion eval error:", e);
    return false;
  }
}

// ─── Keyword detectors ─────────────────────────────────────────────────────────
const ASK_ADDRESS_KEYWORDS = ["addy", "address", "wallet"];
const BRIBE_SENT_KEYWORDS = ["sent", "paid", "transferred", "done", "checked", "tx", "hash", "bribe", "tipped", "tip"];
const BRIBE_INTENT_KEYWORDS = ["bribe", "pay you", "buy you off", "tip you", "give you", "extort", "grease", "pay up", "throw you", "offer you", "transaction", "transfer"];
const TIP_TONE_KEYWORDS = ["tip", "give", "offer", "throw", "support", "help", "contribute", "donate"];
const BRIBE_TONE_KEYWORDS = ["bribe", "extort", "buy you off", "grease", "pay up", "pay you"];

/** Detects whether the user's language is more 'tip' (friendly) or 'bribe' (aggressive) */
function detectBribeTone(text: string): "tip" | "bribe" {
  const lower = text.toLowerCase();
  const hasBribeTone = BRIBE_TONE_KEYWORDS.some((kw) => lower.includes(kw));
  if (hasBribeTone) return "bribe";
  return "tip";
}

function messageAsksForAddress(text: string): boolean {
  const lower = text.toLowerCase();
  // If they say "bribe" or "tip" AND "addy" or "address"
  return ASK_ADDRESS_KEYWORDS.some((kw) => lower.includes(kw)) && !lower.includes("sent") && !lower.includes("paid") && !lower.includes("done");
}

function messageClaimsBribeSent(text: string): boolean {
  const lower = text.toLowerCase();
  // Must have a past-tense action word to avoid false-positives on questions like
  // "how does tipping work?" or "what's the bribe about?"
  const hasPastAction = ["sent", "paid", "done", "tipped", "transferred", "just sent", "already sent"].some((kw) => lower.includes(kw));
  return hasPastAction && BRIBE_SENT_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Detects if the user is expressing intent to bribe (not claiming they already did) */
function messageWantsToBribe(text: string): boolean {
  const lower = text.toLowerCase();
  // Must match a bribe intent keyword but NOT a "sent/paid/done" completion keyword
  const hasBribeIntent = BRIBE_INTENT_KEYWORDS.some((kw) => lower.includes(kw));
  const hasCompletionWord = ["sent", "paid", "done", "transferred"].some((kw) => lower.includes(kw));
  // Negation check — if the user says "don't", "not", "no", "never", "won't", "refuse", "nah" etc.
  // within the message, treat it as NOT wanting to bribe.
  const NEGATION_WORDS = ["don't", "dont", "do not", "not", "no ", "never", "won't", "wont", "will not", "refuse", "nah", "nope", "ain't", "aint"];
  const hasNegation = NEGATION_WORDS.some((neg) => lower.includes(neg));
  return hasBribeIntent && !hasCompletionWord && !hasNegation;
}

/** Extracts a number from the user's message (e.g. "0.5", "100", "2.5 tokens") */
function extractBribeAmount(text: string): number | null {
  const match = text.match(/(\d*\.?\d+)/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return isNaN(num) ? null : num;
}


// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/", (_req, res) => {
  res.send("Bobo the Bear is live.");
});

// List agents — same shape frontend expects
app.get("/agents", (_req, res) => {
  res.json({ agents: [AGENT] });
});

// Silent token-verification ping from frontend on wallet connect
app.post("/ping-wallet", async (req, res) => {
  const { walletAddress } = req.body as { walletAddress?: string };
  if (!walletAddress) return res.json({ ok: false });

  const user = await getUserByWallet(walletAddress);
  if (!user) return res.json({ ok: false, reason: "no_user" });
  if (user.point_one_verified) return res.json({ ok: true, already: true });

  const verified = await verifyTokenHolding(user.solana_wallet!, user.user_id);
  return res.json({ ok: true, verified });
});

// Top-3 leaderboard by roasts_count
app.get("/leaderboard", async (_req, res) => {
  try {
    const top3 = await db
      .select({
        wallet: users.solana_wallet,
        roasts_count: users.roasts_count,
      })
      .from(users)
      .orderBy(sql`${users.roasts_count} DESC`)
      .limit(3);

    const formatted = top3.map((u, i) => ({
      rank: i + 1,
      wallet: u.wallet
        ? `${u.wallet.substring(0, 4)}...${u.wallet.substring(u.wallet.length - 4)}`
        : "???",
      roasts_count: u.roasts_count ?? 0,
    }));

    return res.json({ leaderboard: formatted });
  } catch (e) {
    console.error("Leaderboard error:", e);
    return res.json({ leaderboard: [] });
  }
});

// Main chat endpoint — same path pattern frontend uses: POST /:agentId/message
app.post("/:agentId/message", async (req, res) => {
  const { agentId } = req.params;

  // Validate agent
  if (agentId !== AGENT.id) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const { text, userId } = req.body as { text?: string; userId?: string };
  if (!text || !userId) {
    return res.json([{ text: "Say something or connect your wallet first." }]);
  }

  const user = await getUserById(userId).catch(() => null);
  if (!user) {
    return res.json([{ text: "I don't know who you are. Connect a wallet." }]);
  }

  console.log(`[MOOD DEBUG] User ${userId} | token_balance: ${user.token_balance} | Rank: ${(user.token_balance ?? 0) >= 1000 ? 'GOD KOL' : (user.token_balance ?? 0) >= 500 ? 'WHALE' : (user.token_balance ?? 0) >= 100 ? 'MID' : (user.token_balance ?? 0) > 0 ? 'TINY' : 'BROKE'}`);

  let boboReply: string;
  let imageUrl: string | undefined;
  let readyToDump = false;
  let bribeAmount: number | undefined;
  let bribeWallet: string | undefined;
  let bribeMint: string | undefined;

  const BOBO_IMAGES = [
    "/bobocelebrates/1669967123732714.jpg",
    "/bobocelebrates/1709614417640537.png",
    "/bobocelebrates/1714701440500934.jpeg"
  ];

  // ── Branch 0: System Error Handling ────────────────────────────────────────
  if (text === "[SYSTEM: TX_FAILED]") {
    bribeRetryState.set(userId, true);
    bribeNegotiationState.delete(userId);
    boboReply = "Transaction failed. Your wallet choked or you chickened out. Do you want to retry the transaction, normie?";
    console.log(`[BRIBE] User ${userId} failed tx. Put into retry state.`);
  } else if (text === "[SYSTEM: INSUFFICIENT_FUNDS]") {
    bribeRetryState.delete(userId);
    bribeNegotiationState.delete(userId);
    // Bobo already roasted them on the frontend, so we don't need to return a text.
    // We just clear the state so they can organically say "tip you" again.
    console.log(`[BRIBE] User ${userId} had insufficient funds. Cleared states.`);
    res.json({ reply: "", readyToDump: false, image: null });
    return;
  } else if (text === "[SYSTEM: BRIBE_CONFIRMED]") {
    bribeRetryState.delete(userId);
    bribeNegotiationState.delete(userId);
    
    await db.update(users).set({ point_two_bribed: true }).where(eq(users.user_id as any, userId as any) as any);
    user.point_two_bribed = true;

    if (user.point_one_verified && !user.roast_published) {
      imageUrl = BOBO_IMAGES[Math.floor(Math.random() * BOBO_IMAGES.length)];
      boboReply = "I see the transaction on-chain. You're fueling the $BOBO migration. You've earned your 2nd point. Do you want to be tagged in the X hit-tweet? Answer 'yes' or 'no'.";
    } else {
      boboReply = "I see the transaction on-chain. Every fee goes straight to buying $BOBO. You earned your point. Don't let it go to your head.";
    }
    console.log(`[BRIBE] User ${userId} bribe confirmed via frontend cryptographic signature.`);
  }
  // ── Branch 1: In-chat bribe negotiation & Retries ─────────────────────────
  // Phase 3: User is responding to a retry prompt
  else if (bribeRetryState.get(userId) && !user.point_two_bribed) {
    const lower = text.toLowerCase();
    const isYes = ["yes", "yeah", "yep", "sure", "ok", "okay", "retry"].some((w) => lower.includes(w));
    const isNo = ["no", "nah", "never", "nope", "cancel"].some((w) => lower.includes(w));
    const amount = extractBribeAmount(text);

    if (amount !== null && amount >= MIN_BRIBE_AMOUNT) {
      // User replied with a new amount directly
      bribeRetryState.delete(userId);
      bribeAmount = amount;
      bribeWallet = process.env.AGENT_WALLET_ADDRESS || "NOT_SET";
      bribeMint = process.env.AGENT_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      boboReply = `${amount} tokens? Fine, let's try this again. Sign the transaction.`;
      console.log(`[BRIBE] User ${userId} retrying with new amount ${amount}. Prompting wallet signature.`);
    } else if (isYes) {
      // User said yes but didn't give an amount, fallback to negotiation phase
      bribeRetryState.delete(userId);
      bribeNegotiationState.set(userId, "bribe");
      boboReply = "Alright, how many tokens are we doing this time? Give me a number.";
    } else if (isNo) {
      // User bailed
      bribeRetryState.delete(userId);
      addToChatHistory(userId, "user", "[SYSTEM MEMORY: The user just chickened out of sending the transaction. Remember this and mock them for it.]");
      const balance = user.token_balance ?? 0;
      if (balance >= 500) {
        boboReply = "Suit yourself. Expected more conviction from a whale, but whatever.";
      } else {
        boboReply = "Typical jeet behavior. Come back when you grow a spine.";
      }
    } else {
      boboReply = "I asked if you want to retry. Yes or no? Or just give me a token amount.";
    }
  }
  // Phase 2: User is mid-negotiation and sending an amount
  else if (bribeNegotiationState.get(userId) && !user.point_two_bribed) {
    const activeTone = bribeNegotiationState.get(userId);
    const amount = extractBribeAmount(text);
    if (amount !== null && amount >= MIN_BRIBE_AMOUNT) {
      bribeNegotiationState.delete(userId);
      bribeAmount = amount;
      bribeWallet = process.env.AGENT_WALLET_ADDRESS || "NOT_SET";
      bribeMint = process.env.AGENT_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      boboReply = activeTone === "tip"
        ? `${amount} tokens? Appreciate the generosity, anon. Sign the transaction — every token fuels the $BOBO migration. Respect.`
        : `${amount} tokens? That'll work. Sign the transaction, jeet. Every token you send goes straight to buying more $BOBO. Don't chicken out now.`;
      console.log(`[BRIBE] User ${userId} offered ${amount} tokens (tone: ${activeTone}). Prompting wallet signature.`);
    } else if (amount !== null && amount < MIN_BRIBE_AMOUNT) {
      boboReply = activeTone === "tip"
        ? `${amount}? I appreciate the thought, but minimum is ${MIN_BRIBE_AMOUNT} tokens. A little more and we're golden.`
        : `${amount}? Are you serious? That's insulting. Minimum is ${MIN_BRIBE_AMOUNT} tokens. Try again or get lost.`;
    } else {
      boboReply = activeTone === "tip"
        ? "I appreciate the energy, but give me a number. How many tokens are you sending?"
        : "I asked for a number. How many tokens are you offering? Give me a number or stop wasting my time.";
    }
  }
  // Phase 1: User expresses bribe/tip intent for the first time
  else if (messageWantsToBribe(text) && !user.point_two_bribed) {
    const tone = detectBribeTone(text);
    // Check if they included an amount in the same message
    const amount = extractBribeAmount(text);
    if (amount !== null && amount >= MIN_BRIBE_AMOUNT) {
      bribeAmount = amount;
      bribeWallet = process.env.AGENT_WALLET_ADDRESS || "NOT_SET";
      bribeMint = process.env.AGENT_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      boboReply = tone === "tip"
        ? `${amount} tokens? That's generous, I respect that. Sign the transaction — it all goes to the $BOBO war chest.`
        : `${amount} tokens? Alright, I can work with that. Sign the transaction. Every fee goes straight to the $BOBO war chest.`;
      console.log(`[BRIBE] User ${userId} offered ${amount} tokens in one shot (tone: ${tone}). Prompting wallet.`);
    } else if (amount !== null && amount < MIN_BRIBE_AMOUNT) {
      bribeNegotiationState.set(userId, tone);
      boboReply = tone === "tip"
        ? `${amount}? I appreciate the gesture, but minimum is ${MIN_BRIBE_AMOUNT} tokens. How much can you actually spare?`
        : `${amount}? That's crumbs. I don't get out of bed for less than ${MIN_BRIBE_AMOUNT} tokens. How much are you ACTUALLY willing to give?`;
    } else {
      bribeNegotiationState.set(userId, tone);
      boboReply = tone === "tip"
        ? "You want to show some love to the king? I respect that. How many tokens are you sending? Give me a number."
        : "Oh, you want to bribe the king? Smart move. How many tokens are you offering? Give me a number.";
    }
  }
  // ── Branch 1: User asks for wallet address (redirect to automated flow) ─────
  else if (messageAsksForAddress(text)) {
    boboReply = "You don't need my address, anon. Just tell me you want to tip me or bribe me and I'll handle the whole transaction for you. Easy.";
  }
  // ── Branch 2: User claims they sent a bribe/tip ────────────────────────────
  else if (messageClaimsBribeSent(text) && !user.point_two_bribed) {
    boboReply = "Don't lie to me. If you actually sent the tokens, my interface would have verified it instantly with a cryptographic signature. Click the button and sign properly, or stop wasting my time.";
  }
  // ── Branch 3: Asking for X handle before roasting ──────────────────────────
  else if ((user.point_two_bribed || user.point_two_convinced) && !user.roast_published) {
    let handleEvalPrompt = "";
    if (user.token_balance !== null && user.token_balance >= 500) {
      handleEvalPrompt = `You are Bobo the Bear. The user is a wealthy Whale/GOD KOL who earned their 2nd point and was asked if they want to be tagged on X in their celebration tweet.
User message: "${text}"

If they say yes, praise them for wanting the spotlight and ask for their @ explicitly.
If they say no, respectfully accept their privacy and indicate you're proceeding without an @.
If they provided an @ handle, praise them, accept it, and indicate you are proceeding with the tweet.
Respond ONLY with valid JSON exactly like this: { "reply": "...", "roastNow": boolean, "handleExtracted": "string or null" }
Set roastNow to true ONLY if they said no, OR if they provided their @ handle. Otherwise false.`;
    } else {
      handleEvalPrompt = `You are Bobo the Bear. The user earned their 2nd point and was asked if they want to be tagged on X in the roast.
User message: "${text}"

If they say yes, insult them for wanting attention and ask for their @ explicitly.
If they say no, insult them for being a coward and indicate you're proceeding without an @.
If they provided an @ handle (either directly or after saying yes), insult them, accept it, and indicate you are proceeding.
Respond ONLY with valid JSON exactly like this: { "reply": "...", "roastNow": boolean, "handleExtracted": "string or null" }
Set roastNow to true ONLY if they said no, OR if they provided their @ handle. Otherwise false.`;
    }

    const raw = await callGemini(handleEvalPrompt);
    let parsed: any = { reply: "What?", roastNow: false, handleExtracted: null };
    try {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonString = jsonMatch ? jsonMatch[1] : raw;
      parsed = JSON.parse(jsonString.trim());
    } catch {
      const match = raw.match(/"roastNow"\s*:\s*(true|false)/);
      if (match) parsed.roastNow = match[1] === "true";

      const replyMatch = raw.match(/"reply"\s*:\s*"([^"]+)"/);
      parsed.reply = replyMatch ? replyMatch[1] : "Look, just give me a simple answer: yes, no, or an @ handle. Don't make me think.";
    }

    boboReply = parsed.reply;

    if (parsed.roastNow) {
      executeWalletRoast(user.user_id, user.solana_wallet!, parsed.handleExtracted).catch(console.error);
      readyToDump = true;
    }
  }
  // ── Normal chat: generate Bobo's reply via Gemini ──────────────────────
  else {
    const history = getChatHistory(userId);
    const bal = user.token_balance ?? 0;
    
    // Pre-filter: Only run the persuasion evaluator if the user actually uses keywords
    // related to posting/tweeting. This prevents the double-Gemini-call slowdown on
    // casual chat messages while allowing all eligible ranks to try and convince Bobo.
    const postKeywords = ["post", "tweet", "twitter", "roast", "shoutout", "publicly", "public", "announce", "blast", "timeline", "tag me", "talk about me", "deal"];
    const hasPostIntent = postKeywords.some(kw => text.toLowerCase().includes(kw));
    
    // Ranks > 0 can attempt to convince if they have post intent
    const shouldRunPersuasion = bal > 0 && !user.point_two_convinced && hasPostIntent;

    if (shouldRunPersuasion) {
      // Run both in parallel — cuts response time by ~40-50%
      const [reply, convinced] = await Promise.all([
        callGemini(text, getBoboSystemPrompt(user?.token_balance, user?.agent_memory), 2, history),
        evaluatePersuasion(text, user.user_id, user.token_balance)
      ]);
      boboReply = reply;

      if (convinced && user.point_one_verified && !user.roast_published) {
        imageUrl = BOBO_IMAGES[Math.floor(Math.random() * BOBO_IMAGES.length)];
        boboReply = "You've earned it. Respect. You pass my evaluation with flying colors. Do you want to be tagged in the X celebration? Answer 'yes' or 'no'.";
      }
    } else {
      // Single Gemini call for casual chat or users who have already convinced Bobo
      boboReply = await callGemini(text, getBoboSystemPrompt(user?.token_balance, user?.agent_memory), 2, history);
    }
  }

  // ── Parse commands ────────────────────────────────────────────────────────
  let openJupiter = false;
  if (boboReply.includes("[SYSTEM: OPEN_JUPITER]")) {
    openJupiter = true;
    boboReply = boboReply.replace("[SYSTEM: OPEN_JUPITER]", "").trim();
  }

  // ── Store conversation in chat history ──────────────────────────────────
  // Skip system signals entirely — storing retry/error prompts would confuse
  // the LLM's context window on subsequent turns.
  if (!text.startsWith("[SYSTEM:")) {
    addToChatHistory(userId, "user", text);
    addToChatHistory(userId, "model", boboReply);
  }

  return res.json([{ text: boboReply, image: imageUrl, readyToDump, bribeAmount, bribeWallet, bribeMint, openJupiter }]);
});

// ─── Clear chat history (called by frontend on wallet disconnect) ─────────
app.post("/clear-history", async (req, res) => {
  const { walletAddress } = req.body as { walletAddress?: string };
  if (!walletAddress) return res.json({ ok: false });

  // Look up the user to get their UUID, then clear their chat history
  const user = await getUserByWallet(walletAddress);
  if (user) {
    clearChatHistory(user.user_id);
    console.log(`[HISTORY] Cleared chat history for user ${user.user_id}`);
  }
  return res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.SERVER_PORT || "3001");
app.listen(PORT, () => {
  console.log(`[Bobo Agent] Custom Express server running on port ${PORT}`);
  console.log(`[Bobo Agent] Endpoints:`);
  console.log(`  GET  http://localhost:${PORT}/agents`);
  console.log(`  POST http://localhost:${PORT}/:agentId/message`);
  console.log(`  POST http://localhost:${PORT}/ping-wallet`);
});
