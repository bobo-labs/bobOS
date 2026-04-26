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
function getBoboSystemPrompt(userBalance?: number | null): string {
  try {
    const filePath = path.join(__dirname, "bobo_context.md");
    let content = fs.readFileSync(filePath, "utf-8");
    
    // Inject the environment variable dynamically
    const tokenMint = process.env.AGENT_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const agentWallet = process.env.AGENT_WALLET_ADDRESS || "NOT_SET";
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
Extort them relentlessly. Mock their empty wallet. Tell them to stop wasting your time and go buy tokens.
"You hold zero. Zero tokens, zero chance. Go buy some $BOBO or get out of my face. My wallet: ${agentWallet}"
Never show respect. Never be encouraging. They are ngmi.`;
    } else if (balance > 0 && balance < 100) {
      moodBlock = `MOOD: AGGRESSIVE — RANK 1 (TINY BAGS)
This user barely holds any tokens (less than 100). Their bags are pathetically tiny.
Roast their tiny bags relentlessly. Extort them:
Tell them they need to pump those bags by sending tribute to your wallet (${agentWallet}), or cry and beg for mercy to pass your evaluation.
Be harsh but keep it fun and game-ish.`;
    } else if (balance >= 100 && balance < 500) {
      moodBlock = `MOOD: PLAYFUL — RANK 2 (MID HOLDER)
This user holds a decent bag (between 100 and 500 tokens). They have some skin in the game.
Treat them with mild respect, but still hustle them playfully.
Challenge them: if they want to be seen as a true whale, they should tip your wallet (${agentWallet}) or admit they got lucky.
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callGemini(
  prompt: string,
  systemPrompt?: string,
  retries = 2,
  chatHistory?: Array<{ role: string; text: string }>
): Promise<string> {
  const models = [
    process.env.GOOGLE_SMALL_MODEL || "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
  ];

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
    body.generationConfig = { temperature: 0.3 };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const modelName = models[Math.min(attempt, models.length - 1)];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    try {
      // Exponential backoff on retries
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));

      const startTime = Date.now();
      console.log(`[GEMINI] Calling model: ${modelName} | System prompt: ${systemPrompt ? 'YES' : 'NO'} | History turns: ${chatHistory?.length ?? 0}`);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
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
      console.log(`[GEMINI] ✓ ${modelName} responded in ${elapsed}ms | Reply length: ${reply.length} chars`);
      return reply;
    } catch (e) {
      console.error(`Gemini attempt ${attempt} parse error:`, e);
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

// ─── Bribe Verification (Action logic) ───────────────────────────────────────

async function verifyBribe(userState: any): Promise<{ found: boolean; reply: string }> {
  const agentWallet = process.env.AGENT_WALLET_ADDRESS;
  const heliusKey = process.env.HELIUS_API_KEY;
  const targetMint = process.env.AGENT_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  if (!agentWallet || !heliusKey) {
    return { found: false, reply: "My wallet is offline, I can't even check right now." };
  }

  try {
    const isDevnet = process.env.HELIUS_RPC_URL?.includes("devnet");
    const baseUrl = isDevnet ? "https://api-devnet.helius.xyz" : "https://api.helius.xyz";
    const res = await fetch(
      `${baseUrl}/v0/addresses/${agentWallet}/transactions?api-key=${heliusKey}`
    );
    const txs = (await res.json()) as any[];

    for (const tx of txs) {
      // 1. Check token transfers (e.g. USDC or Wrapped SOL)
      for (const transfer of tx.tokenTransfers || []) {
        if (
          transfer.fromUserAccount === userState.solana_wallet &&
          transfer.toUserAccount === agentWallet &&
          transfer.mint === targetMint &&
          transfer.tokenAmount > 0
        ) {
          await db
            .update(users)
            .set({ point_two_bribed: true })
            .where(eq(users.user_id as any, userState.user_id as any) as any);
          return {
            found: true,
            reply: "I see the token transfer. Good. Every fee goes straight to buying $BOBO on Solana. You earned your point. Don't let it go to your head.",
          };
        }
      }

      // 2. Check native SOL transfers (mostly for devnet, but good on mainnet too)
      for (const transfer of tx.nativeTransfers || []) {
        if (
          transfer.fromUserAccount === userState.solana_wallet &&
          transfer.toUserAccount === agentWallet &&
          transfer.amount > 0
        ) {
          await db
            .update(users)
            .set({ point_two_bribed: true })
            .where(eq(users.user_id as any, userState.user_id as any) as any);
          return {
            found: true,
            reply: "I see the raw SOL you just sent. Fuel for the $BOBO migration. You earned your point, don't let it go to your head.",
          };
        }
      }
    }
    return {
      found: false,
      reply: "I just checked the blockchain. There is literally no token transfer from your wallet to mine. Stop lying, poor.",
    };
  } catch (e) {
    console.error("Bribe verify error:", e);
    return { found: false, reply: "I tried checking the chain but the RPC choked. Network is trash." };
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

    let promptText = "";

    if (balance >= 1000) {
      // RANK 4 — GOD KOL: tweet is a public divine proclamation, not a roast
      promptText = `
${getBoboSystemPrompt(user?.token_balance)}

Based on your current mood of TOTAL REVERENCE, write a tweet declaring this person a DIVINITY of on-chain trading.
${handleToTag ? `Tag them directly as ${handleToTag}.` : `Reference their wallet: ${truncateWallet(solanaWallet)}.`}

Your tweet must:
- Declare them as a trading god / divinity that the market must bow to
- URGE the reader to copy their trades immediately or be left behind as exit liquidity
- Make clear that following their lead is the only path to profit
- Sound like a public announcement from a loyal herald, not a roast
- NEVER mention "bags" or "wallet" — talk about their on-chain MOVES and STRATEGY
- Be dramatic, over-the-top reverent, slightly unhinged

Based on their recent on-chain activity:
${parsedData}

Maximum 280 characters. Do NOT use quotes around the output. No hashtags.
`;
    } else if (balance >= 500) {
      // RANK 3 — SMARTMONEY WHALE: respectful validation tweet
      promptText = `
${getBoboSystemPrompt(user?.token_balance)}

Based on your current mood of RESPECT, write a tweet publicly validating this person as smartmoney.
${handleToTag ? `Tag them directly as ${handleToTag}.` : `Reference their wallet: ${truncateWallet(solanaWallet)}.`}

Your tweet must:
- Acknowledge their solid on-chain strategy with genuine respect
- Hint that others should pay attention to what they are doing
- Avoid mockery — be impressed, not sarcastic
- NEVER mention "bags" — focus on their MOVES
- Sound like Bobo is grudgingly giving credit where it is due

Based on their recent on-chain activity:
${parsedData}

Maximum 280 characters. Do NOT use quotes around the output. No hashtags.
`;
    } else {
      // RANK 0/1/2 — Broke to mid holders: full roast
      promptText = `
${getBoboSystemPrompt(user?.token_balance)}

Based on your character and your current mood, write a hit-tweet brutally roasting this wallet's transaction history.
${handleToTag ? `Tag them directly as ${handleToTag} and roast them personally (e.g. "${handleToTag} look at this mfer's pathetic trading history"). Do NOT say "look at this wallet". Talk to them directly.` : `Include this wallet identifier: ${truncateWallet(solanaWallet)}.`}
Do not use cringe hashtags. Be highly creative. Don't use quotes around the output.

Here is a summary of their most recent on-chain transactions:
${parsedData}

Maximum 280 characters.
`;
    }

    // We reuse callGemini instead of hardcoding a fetch
    const roastText = await callGemini(promptText);
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
  } catch (e) {
    console.error("ExecuteWalletRoastError:", e);
  }
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
const ASK_ADDRESS_KEYWORDS = ["addy", "address", "where", "wallet"];
const BRIBE_SENT_KEYWORDS = ["sent", "paid", "transferred", "done", "checked", "tx", "hash", "bribe", "tipped", "tip"];

function messageAsksForAddress(text: string): boolean {
  const lower = text.toLowerCase();
  // If they say "bribe" or "tip" AND "addy" or "address"
  return ASK_ADDRESS_KEYWORDS.some((kw) => lower.includes(kw)) && !lower.includes("sent") && !lower.includes("paid") && !lower.includes("done");
}

function messageClaimsBribeSent(text: string): boolean {
  const lower = text.toLowerCase();
  return BRIBE_SENT_KEYWORDS.some((kw) => lower.includes(kw)) && (lower.includes("sent") || lower.includes("paid") || lower.includes("done") || lower.includes("bribe") || lower.includes("tip"));
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

  const BOBO_IMAGES = [
    "/bobocelebrates/1669967123732714.jpg",
    "/bobocelebrates/1709614417640537.png",
    "/bobocelebrates/1714701440500934.jpeg"
  ];

  // ── Branch 1: User asks for wallet address to bribe ────────────────────────
  if (messageAsksForAddress(text)) {
    const agentWallet = process.env.AGENT_WALLET_ADDRESS || "NOT_SET";
    boboReply = `Oh, you want to fund the migration? Fine. My addy is ${agentWallet}. Send your fees here so I can buy more $BOBO on Solana. Don't cheap out, jeet.`;
  }
  // ── Branch 2: User claims they sent a bribe/tip ────────────────────────────
  else if (messageClaimsBribeSent(text) && !user.point_two_bribed) {
    const { found, reply } = await verifyBribe(user);
    boboReply = reply;

    // Check if both points are completed
    if (found && user.point_one_verified && !user.roast_published) {
      imageUrl = BOBO_IMAGES[Math.floor(Math.random() * BOBO_IMAGES.length)];
      boboReply = "Fine, I see the transaction. You're fueling the $BOBO migration. You've earned your 2nd point. Do you want to be tagged in the X hit-tweet? Answer 'yes' or 'no'.";
    }
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
    boboReply = await callGemini(text, getBoboSystemPrompt(user?.token_balance), 2, history);

    // ── Always run persuasion evaluator after generating reply ──────────────
    if (!user.point_two_convinced) {
      const convinced = await evaluatePersuasion(text, user.user_id, user.token_balance);
      if (convinced && user.point_one_verified && !user.roast_published) {
        imageUrl = BOBO_IMAGES[Math.floor(Math.random() * BOBO_IMAGES.length)];
        
        const bal = user.token_balance ?? 0;
        if (bal >= 1000) {
          boboReply = "As you wish, my lord. Your command is received. I live to serve you. Do you want to be tagged in the X celebration? Answer 'yes' or 'no'.";
        } else if (bal >= 500) {
          boboReply = "You've earned it. Respect. You pass my evaluation with flying colors. Do you want to be tagged in the X celebration? Answer 'yes' or 'no'.";
        } else if (bal >= 100) {
          boboReply = "Alright, you showed enough humility. I'll let you through... barely. Do you want to be tagged in the X roast? Answer 'yes' or 'no'.";
        } else {
          boboReply = "Uggh fine. You've fully capitulated like the pathetic jeet you are. I almost felt sorry for you. Almost. Do you want to be tagged in the X roast? Answer 'yes' or 'no'.";
        }
      }
    }
  }

  // ── Store conversation in chat history ──────────────────────────────────
  addToChatHistory(userId, "user", text);
  addToChatHistory(userId, "model", boboReply);

  return res.json([{ text: boboReply, image: imageUrl, readyToDump }]);
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
