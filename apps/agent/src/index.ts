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
import { db, users, proposals, votes } from "@bobos/database";
import { eq, sql } from "drizzle-orm";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { configureApi, api } from "@coin-communities/sdk";
import Parser from "rss-parser";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({
  origin: [
    "https://ai.bobolabs.xyz",
    "https://web-production-f4e78.up.railway.app",
    "http://localhost:3000"
  ]
}));
app.use(express.json());

// ─── Configure Coin Communities SDK ─────────────────────────────────────────
const ccServerKey = process.env.CC_SERVER_KEY || "";
const ccServerSecret = process.env.CC_SERVER_SECRET || "";

if (ccServerKey && ccServerSecret) {
  configureApi({
    baseUrl: "https://api.coin-communities.xyz",
    headers: {
      "x-server-key": ccServerKey,
      "x-server-secret": ccServerSecret,
    },
  });
  console.log("[COIN_COMMUNITIES] SDK configured successfully.");
} else {
  console.warn("[COIN_COMMUNITIES] Warning: CC_SERVER_KEY or CC_SERVER_SECRET is missing. Forwarder will be inactive.");
}


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
    } else if (balance > 0 && balance < 10000) {
      moodBlock = `MOOD: AGGRESSIVE — RANK 1 (TINY BAGS)
This user barely holds any tokens (less than 10,000). Their bags are pathetically tiny.
Roast their tiny bags relentlessly. Extort them:
Tell them they need to pump those bags, or cry and beg for mercy to pass your evaluation.
If they want to tip or bribe you, they just need to SAY "tip you" or "bribe you" in the chat — the transaction is handled automatically. NEVER share a raw wallet address.
Be harsh but keep it fun and game-ish.`;
    } else if (balance >= 10000 && balance < 100000) {
      moodBlock = `MOOD: PLAYFUL — RANK 2 (MID HOLDER)
This user holds a decent bag (between 10,000 and 100,000 tokens). They have some skin in the game.
Treat them with mild respect, but still hustle them playfully.
Challenge them: if they want to be seen as a true whale, they can tip you or admit they got lucky.
If they want to tip or bribe you, they just need to SAY it in the chat — the transaction is handled automatically. NEVER share a raw wallet address.
Be cheeky, not hostile.`;
    } else if (balance >= 100000 && balance < 1000000) {
      moodBlock = `MOOD: BACKHANDED RESPECT — RANK 3 (SMARTMONEY WHALE)
This user holds over 100,000 tokens. Decent bags. Not bad. But not legendary either.
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
This user is a GOD KOL holding over 1,000,000 tokens. They are the apex predator of trading.
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

// ─── Proposal and Vote States ────────────────────────────────────────────────
const proposalStates = new Map<string, {
  stage: number;
  title?: string;
  recipient?: string;
  amount?: number;
  challenge?: string;
}>();

const voteStates = new Map<string, {
  proposalId: string;
  vote: 'yes' | 'no';
  challenge: string;
}>();

function verifySolanaSignature(walletAddress: string, message: string, signatureHex: string): boolean {
  try {
    const signature = Uint8Array.from(Buffer.from(signatureHex, "hex"));
    const messageBytes = new TextEncoder().encode(message);
    const publicKeyBytes = bs58.decode(walletAddress);
    return nacl.sign.detached.verify(messageBytes, signature, publicKeyBytes);
  } catch (e) {
    console.error("Signature verification error:", e);
    return false;
  }
}

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
  //   chat:      3.1-flash-lite → 2.5-flash-lite → 3.5-flash
  //   evaluator: 3.1-flash-lite → 2.5-flash-lite → 3.5-flash
  //   tweet:     3.1-flash-lite → 2.5-flash-lite → 3.5-flash
  const modelSets: Record<GeminiPurpose, string[]> = {
    chat: [
      process.env.GOOGLE_SMALL_MODEL || "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash"
    ],
    evaluator: [
      process.env.GOOGLE_SMALL_MODEL || "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash"
    ],
    tweet: [
      process.env.GOOGLE_SMALL_MODEL || "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash"
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
    body.generationConfig = { temperature: 0.3, maxOutputTokens: purpose === "evaluator" ? 300 : undefined };
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
  if (userId === "test-whale-uuid") {
    await db
      .update(users)
      .set({ point_one_verified: true, token_balance: 1500000 })
      .where(eq(users.user_id as any, userId as any) as any);
    return true;
  }
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

// ─── On-Chain Bribe Verification ──────────────────────────────────────────────
// Fetches the parsed transaction from the RPC and verifies that a real
// transferChecked (or transfer) instruction moved tokens from the sender
// using the expected mint, with an amount >= MIN_BRIBE_AMOUNT.

async function verifyBribeTransaction(signature: string, senderWallet: string): Promise<boolean> {
  try {
    const rpcUrl = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "verify-bribe",
        method: "getTransaction",
        params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
      }),
    });

    const data = (await response.json()) as any;
    const tx = data.result;

    if (!tx || tx.meta?.err !== null) {
      console.error(`[BRIBE VERIFY] Transaction not found or errored. Sig: ${signature}`);
      return false;
    }

    // Look for a transferChecked or transfer instruction matching our expected mint and sender
    const tokenMint = process.env.AGENT_TOKEN_MINT || "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump";

    const instructions = tx.transaction?.message?.instructions || [];
    const innerInstructions = tx.meta?.innerInstructions?.flatMap((ii: any) => ii.instructions) || [];
    const allInstructions = [...instructions, ...innerInstructions];

    for (const ix of allInstructions) {
      const parsed = ix.parsed;
      if (!parsed) continue;

      if (parsed.type === "transferChecked" || parsed.type === "transfer") {
        const info = parsed.info;
        // Verify: the source authority is the sender and the mint matches
        if (info.authority === senderWallet && info.mint === tokenMint) {
          const amount = parseFloat(info.tokenAmount?.uiAmount ?? info.amount ?? "0");
          if (amount >= MIN_BRIBE_AMOUNT) {
            console.log(`[BRIBE VERIFY] ✓ Verified transfer of ${amount} tokens from ${senderWallet}`);
            return true;
          }
        }
      }
    }

    console.warn(`[BRIBE VERIFY] No qualifying transfer found in tx ${signature}`);
    return false;
  } catch (e) {
    console.error(`[BRIBE VERIFY] RPC error:`, e);
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
${handleToTag ? `Include their tag ${handleToTag} in the tweet — but NEVER start the tweet with the @ symbol. Put a word, emoji, or phrase before the tag.` : `Reference their wallet: ${truncateWallet(solanaWallet)}.`}

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
${handleToTag ? `Include their tag ${handleToTag} in the tweet — but NEVER start the tweet with the @ symbol. Put a word, emoji, or phrase before the tag.` : `Reference their wallet: ${truncateWallet(solanaWallet)}.`}

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
${handleToTag ? `Include their tag ${handleToTag} in the tweet — but NEVER start the tweet with the @ symbol. Put a word, emoji, or phrase before the tag so it shows as a public post, not a reply.` : `Include this wallet identifier: ${truncateWallet(solanaWallet)}.`}

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

    // Guard: tweets starting with @ are classified as replies by Twitter.
    // Prepend a bear emoji to force it into a standalone post.
    let finalTweet = roastText;
    if (finalTweet.trimStart().startsWith("@")) {
      finalTweet = "🐻 " + finalTweet.trimStart();
      console.log("[TWEET] Prepended emoji — original started with @, would have been a reply.");
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
      body: JSON.stringify({ text: finalTweet.substring(0, 280) })
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

    if (balance >= 1000000) {
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

    } else if (balance >= 100000) {
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

    } else if (balance >= 10000) {
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

    const rankLabel = balance >= 1000000 ? 4 : balance >= 100000 ? 3 : balance >= 10000 ? 2 : 1;
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
    if (balance >= 100000 && balance < 1000000 && parsed.convinced) {
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

// Webhook endpoint to receive new tweets from Make.com/Zapier and forward to Coin Communities
app.post("/api/forward-tweet", async (req, res) => {
  try {
    const { twitterId, tweetText, tweetId, walletAddress, chainId } = req.body as {
      twitterId?: string;
      tweetText?: string;
      tweetId?: string;
      walletAddress?: string;
      chainId?: "solana" | "ethereum" | "base" | "bsc";
    };

    const webhookSecret = req.headers["x-webhook-secret"];
    const expectedSecret = process.env.TWEET_FORWARDER_SECRET;

    if (!expectedSecret || webhookSecret !== expectedSecret) {
      console.warn(`[FORWARDER] Unauthorized access attempt from IP ${req.ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!twitterId || !tweetText || !tweetId) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Extract numeric tweet ID if a full URL was passed
    let parsedTweetId = tweetId.trim();
    if (parsedTweetId.includes("/status/")) {
      const match = parsedTweetId.match(/\/status\/(\d+)/);
      if (match && match[1]) {
        parsedTweetId = match[1];
      }
    }

    const tokenAddress = process.env.CC_TOKEN_ADDRESS || process.env.AGENT_TOKEN_MINT || "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump";
    const finalChainId = chainId || "solana";
    const finalWalletAddress = walletAddress || process.env.AGENT_WALLET_ADDRESS || "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump";

    console.log(`[FORWARDER] Received request body:`, JSON.stringify(req.body));
    console.log(`[FORWARDER] Forwarding tweet ${parsedTweetId} on behalf of Twitter ID ${twitterId} to room ${tokenAddress}`);

    // Format content with original tweet link
    const formattedContent = `${tweetText}\n\n🔗 Original tweet: https://x.com/i/web/status/${parsedTweetId}`;

    // Determine whether to use client-side api.postMessage (via USER_ACCESS_TOKEN) or server-side api.postMessageServer
    const userAccessToken = process.env.USER_ACCESS_TOKEN;
    let response;

    if (userAccessToken) {
      console.log(`[FORWARDER] Using user access token for client-side posting to room ${tokenAddress} with wallet ${finalWalletAddress} (${finalChainId})`);
      configureApi({
        baseUrl: "https://api.coin-communities.xyz",
        headers: {
          "x-api-key": process.env.CC_API_KEY || "",
          "Authorization": `Bearer ${userAccessToken.trim()}`
        }
      });

      // Query and log linked wallets to diagnose mismatches
      try {
        const walletsRes = await api.getWallets({});
        console.log(`[FORWARDER] Linked wallets:`, JSON.stringify(walletsRes.data));
      } catch (err) {
        console.error(`[FORWARDER] Failed to fetch linked wallets:`, err);
      }

      response = await api.postMessage({
        path: { token_address: tokenAddress },
        body: {
          content: formattedContent,
          chainId: finalChainId,
          walletAddress: finalWalletAddress,
        },
      });

      console.log(`[FORWARDER] postMessage response: status=${response.response?.status}, data=${JSON.stringify(response.data)}, error=${JSON.stringify(response.error)}`);

      // Restore server credentials afterwards
      if (ccServerKey && ccServerSecret) {
        configureApi({
          baseUrl: "https://api.coin-communities.xyz",
          headers: {
            "x-server-key": ccServerKey,
            "x-server-secret": ccServerSecret,
          },
        });
      }
    } else {
      console.log(`[FORWARDER] Using server credentials to post to room ${tokenAddress}`);
      response = await api.postMessageServer({
        path: { token_address: tokenAddress },
        body: {
          content: formattedContent,
          twitterId: twitterId,
          chainId: finalChainId,
          walletAddress: finalWalletAddress,
        },
      });
    }

    if (response.error) {
      console.error("[FORWARDER] Coin Communities API error:", response.error);
      return res.status(500).json({ error: "Coin Communities API error", details: response.error });
    }

    return res.json({ success: true, message: "Tweet forwarded successfully to Coin Communities" });
  } catch (error: any) {
    console.error("[FORWARDER] Internal server error:", error);
    return res.status(500).json({ error: "Internal server error", message: error?.message });
  }
});

// X Activity API (XAA) Webhook - GET Challenge-Response Check (CRC)
app.get("/api/twitter-webhook", (req, res) => {
  const crcToken = req.query.crc_token as string;
  if (!crcToken) {
    return res.status(400).json({ error: "Missing crc_token parameter" });
  }

  const consumerSecret = process.env.TWITTER_API_SECRET_KEY;
  if (!consumerSecret) {
    console.error("[TWITTER CRC] Consumer secret is missing in environment.");
    return res.status(500).json({ error: "Configuration error" });
  }

  try {
    const hmac = crypto.createHmac("sha256", consumerSecret).update(crcToken).digest("base64");
    console.log(`[TWITTER CRC] Verification succeeded for token: ${crcToken}`);
    return res.status(200).json({
      response_token: `sha256=${hmac}`
    });
  } catch (error: any) {
    console.error("[TWITTER CRC] Exception calculating hmac:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// X Activity API (XAA) Webhook - POST Event Processor
app.post("/api/twitter-webhook", async (req, res) => {
  try {
    // Acknowledge receipt immediately to avoid X timeout (3-second limit)
    res.status(200).send("OK");

    const payload = req.body;

    if (!payload || !payload.tweet_create_events || !Array.isArray(payload.tweet_create_events)) {
      return;
    }

    const twitterUserId = process.env.TWITTER_USER_ID;
    if (!twitterUserId) {
      console.warn("[TWITTER WEBHOOK] Received events but TWITTER_USER_ID is not set in env.");
      return;
    }

    for (const tweet of payload.tweet_create_events) {
      const authorId = tweet.user?.id_str;

      // Filter: only tweets from our account
      if (authorId !== twitterUserId) {
        continue;
      }

      // Filter out standard retweets and replies
      const isRetweet = !!tweet.retweeted_status;
      const isReply = !!tweet.in_reply_to_status_id;

      if (isRetweet || isReply) {
        console.log(`[TWITTER WEBHOOK] Ignoring retweet or reply: ${tweet.id_str}`);
        continue;
      }

      console.log(`[TWITTER WEBHOOK] Processing new tweet from ${tweet.user?.screen_name}: ${tweet.id_str} — "${tweet.text}"`);

      // Forward to Coin Communities
      const success = await forwardTweetInternally({
        tweetId: tweet.id_str,
        tweetText: tweet.text || "",
        twitterId: authorId,
      });

      if (success) {
        console.log(`[TWITTER WEBHOOK] Successfully forwarded tweet ${tweet.id_str} to Coin Communities!`);
      } else {
        console.error(`[TWITTER WEBHOOK] Failed to forward tweet ${tweet.id_str}`);
      }
    }
  } catch (error) {
    console.error("[TWITTER WEBHOOK] Error processing incoming payload:", error);
  }
});


// serving local interactive HTML page for linking developer wallets securely
app.get("/link-wallet", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Wallet to Coin Communities</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Space+Mono&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0B0D17;
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.08);
      --text: #F3F4F6;
      --text-muted: #9CA3AF;
      --primary: #9333EA;
      --primary-hover: #A855F7;
      --accent: #22D3EE;
      --success: #10B981;
      --error: #EF4444;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', sans-serif;
      background: var(--bg);
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(147, 51, 234, 0.1) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(34, 211, 238, 0.08) 0%, transparent 40%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    
    .container {
      max-width: 550px;
      width: 100%;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(16px);
      border-radius: 24px;
      padding: 3rem 2.5rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      animation: fadeIn 0.8s ease-out;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    h1 {
      font-size: 2.25rem;
      font-weight: 800;
      text-align: center;
      margin-bottom: 0.75rem;
      background: linear-gradient(135deg, #FFF 30%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    
    .subtitle {
      font-size: 1rem;
      color: var(--text-muted);
      text-align: center;
      margin-bottom: 2.5rem;
      line-height: 1.5;
    }
    
    .step-card {
      background: rgba(255, 255, 255, 0.015);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 16px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      transition: all 0.3s ease;
    }
    
    .step-card.active {
      border-color: rgba(147, 51, 234, 0.4);
      background: rgba(147, 51, 234, 0.02);
      box-shadow: 0 0 20px rgba(147, 51, 234, 0.05);
    }
    
    .step-header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 0.75rem;
    }
    
    .step-number {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    
    .step-card.active .step-number {
      background: var(--primary);
      color: white;
    }
    
    .step-title {
      font-size: 1.125rem;
      font-weight: 600;
    }
    
    .step-desc {
      font-size: 0.875rem;
      color: var(--text-muted);
      line-height: 1.4;
      margin-bottom: 1rem;
    }
    
    .btn {
      width: 100%;
      padding: 0.875rem;
      border-radius: 12px;
      border: none;
      font-family: inherit;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    
    .btn-primary {
      background: var(--primary);
      color: white;
    }
    
    .btn-primary:hover:not(:disabled) {
      background: var(--primary-hover);
      transform: translateY(-1px);
    }
    
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
    }
    
    .btn-secondary:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.12);
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-top: 0.5rem;
    }
    
    .status-badge.success {
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
    }
    
    .status-badge.pending {
      background: rgba(245, 158, 11, 0.1);
      color: #F59E0B;
    }
    
    .info-box {
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      padding: 0.75rem;
      margin-top: 0.75rem;
      word-break: break-all;
      color: var(--accent);
    }
    
    .log-box {
      margin-top: 2rem;
      border-top: 1px solid var(--card-border);
      padding-top: 1.5rem;
    }
    
    .log-title {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
    }
    
    .log-content {
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.03);
      border-radius: 12px;
      padding: 1rem;
      max-height: 150px;
      overflow-y: auto;
      color: var(--text-muted);
      line-height: 1.5;
    }
    
    .log-line {
      margin-bottom: 0.25rem;
    }
    .log-line.error { color: var(--error); }
    .log-line.success { color: var(--success); }
    .log-line.info { color: var(--accent); }
  </style>
</head>
<body>

  <div class="container">
    <h1>Link Developer Wallet</h1>
    <div class="subtitle">Securely link your Solana wallet to your Twitter account under your project's custom API key.</div>
    
    <!-- Step 1 -->
    <div class="step-card active" id="card-step1">
      <div class="step-header">
        <div class="step-number">1</div>
        <div class="step-title">Connect Wallet</div>
      </div>
      <div class="step-desc">Connect the Solana wallet holding your assets (Phantom or Solflare).</div>
      <button class="btn btn-primary" id="btn-connect">Connect Solana Wallet</button>
      <div id="wallet-info" style="display:none;">
        <div class="status-badge success">✓ Connected</div>
        <div class="info-box" id="wallet-address-text"></div>
      </div>
    </div>
    
    <!-- Step 2 -->
    <div class="step-card" id="card-step2">
      <div class="step-header">
        <div class="step-number">2</div>
        <div class="step-title">Get Cryptographic Challenge</div>
      </div>
      <div class="step-desc">Fetch a unique signature request challenge from Coin Communities.</div>
      <button class="btn btn-secondary" id="btn-challenge" disabled>Request Challenge</button>
      <div id="challenge-info" style="display:none;">
        <div class="status-badge success">✓ Challenge Issued</div>
        <div class="info-box" id="challenge-text"></div>
      </div>
    </div>
    
    <!-- Step 3 -->
    <div class="step-card" id="card-step3">
      <div class="step-header">
        <div class="step-number">3</div>
        <div class="step-title">Sign & Submit Link</div>
      </div>
      <div class="step-desc">Sign the message in your wallet and publish the linkage.</div>
      <button class="btn btn-secondary" id="btn-sign" disabled>Sign & Link Wallet</button>
      <div id="final-status" style="display:none;">
        <div class="status-badge" id="final-badge"></div>
      </div>
    </div>
    
    <!-- Logs -->
    <div class="log-box">
      <div class="log-title">Activity Log</div>
      <div class="log-content" id="log-container">
        <div class="log-line info">[System] Ready to connect wallet.</div>
      </div>
    </div>
  </div>

  <script>
    const elBtnConnect = document.getElementById('btn-connect');
    const elBtnChallenge = document.getElementById('btn-challenge');
    const elBtnSign = document.getElementById('btn-sign');
    const elWalletInfo = document.getElementById('wallet-info');
    const elChallengeInfo = document.getElementById('challenge-info');
    const elWalletAddressText = document.getElementById('wallet-address-text');
    const elChallengeText = document.getElementById('challenge-text');
    const elFinalStatus = document.getElementById('final-status');
    const elFinalBadge = document.getElementById('final-badge');
    const elLogContainer = document.getElementById('log-container');
    
    const card1 = document.getElementById('card-step1');
    const card2 = document.getElementById('card-step2');
    const card3 = document.getElementById('card-step3');

    let walletAddress = null;
    let challenge = null;

    function addLog(msg, type = 'default') {
      const line = document.createElement('div');
      line.className = 'log-line ' + type;
      line.innerText = \`[\${new Date().toLocaleTimeString()}] \${msg}\`;
      elLogContainer.appendChild(line);
      elLogContainer.scrollTop = elLogContainer.scrollHeight;
    }

    // Base58 Encoder for Solana Signatures
    function bufferToBase58(buffer) {
      const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const digits = [0];
      for (let i = 0; i < buffer.length; i++) {
        let carry = buffer[i];
        for (let j = 0; j < digits.length; j++) {
          carry += digits[j] << 8;
          digits[j] = carry % 58;
          carry = (carry / 58) | 0;
        }
        while (carry > 0) {
          digits.push(carry % 58);
          carry = (carry / 58) | 0;
        }
      }
      for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
        digits.push(0);
      }
      return digits.reverse().map(d => ALPHABET[d]).join('');
    }

    // Step 1: Connect Wallet
    elBtnConnect.addEventListener('click', async () => {
      try {
        if (!window.solana) {
          alert('Solana wallet (Phantom) not detected! Please install Phantom.');
          addLog('Phantom wallet extension not found.', 'error');
          return;
        }
        
        addLog('Connecting to Solana wallet...');
        const resp = await window.solana.connect();
        walletAddress = resp.publicKey.toString();
        
        elWalletAddressText.innerText = walletAddress;
        elWalletInfo.style.display = 'block';
        elBtnConnect.style.display = 'none';
        
        card1.classList.remove('active');
        card2.classList.add('active');
        elBtnChallenge.disabled = false;
        elBtnChallenge.className = 'btn btn-primary';
        
        addLog(\`Connected to wallet: \${walletAddress}\`, 'success');
      } catch (err) {
        addLog(\`Wallet connection error: \${err.message}\`, 'error');
      }
    });

    // Step 2: Request Challenge
    elBtnChallenge.addEventListener('click', async () => {
      try {
        addLog('Requesting cryptographic challenge from backend...');
        elBtnChallenge.disabled = true;
        
        const res = await fetch('/api/link-wallet/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress })
        });
        
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || 'Failed to fetch challenge');
        }
        
        challenge = data.challenge;
        elChallengeText.innerText = challenge;
        elChallengeInfo.style.display = 'block';
        elBtnChallenge.style.display = 'none';
        
        card2.classList.remove('active');
        card3.classList.add('active');
        elBtnSign.disabled = false;
        elBtnSign.className = 'btn btn-primary';
        
        addLog('Challenge received successfully.', 'success');
      } catch (err) {
        elBtnChallenge.disabled = false;
        addLog(\`Failed to fetch challenge: \${err.message}\`, 'error');
      }
    });

    // Step 3: Sign & Submit Link
    elBtnSign.addEventListener('click', async () => {
      try {
        addLog('Prompting signature in wallet...');
        elBtnSign.disabled = true;
        
        const encodedMessage = new TextEncoder().encode(challenge);
        const signedMessage = await window.solana.signMessage(encodedMessage, "utf8");
        const signatureBase58 = bufferToBase58(signedMessage.signature);
        
        addLog('Signature generated. Submitting linkage back to backend...', 'info');
        
        const res = await fetch('/api/link-wallet/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress,
            signature: signatureBase58
          })
        });
        
        const data = await res.json();
        elFinalStatus.style.display = 'block';
        
        if (!res.ok || data.error) {
          elFinalBadge.className = 'status-badge error';
          elFinalBadge.innerText = '✗ Linking Failed';
          throw new Error(data.error || 'Linking failed');
        }
        
        elFinalBadge.className = 'status-badge success';
        elFinalBadge.innerText = '✓ Wallet Successfully Linked!';
        elBtnSign.style.display = 'none';
        card3.classList.remove('active');
        
        addLog('Wallet successfully linked on Coin Communities!', 'success');
      } catch (err) {
        elBtnSign.disabled = false;
        addLog(\`Linking error: \${err.message}\`, 'error');
      }
    });
  </script>
</body>
</html>`);
});

// Fetch challenge from Coin Communities using the userAccessToken & CC_API_KEY
app.post("/api/link-wallet/challenge", async (req, res) => {
  try {
    const { walletAddress } = req.body as { walletAddress?: string };
    const userAccessToken = process.env.USER_ACCESS_TOKEN;

    if (!walletAddress) {
      return res.status(400).json({ error: "Missing walletAddress" });
    }
    if (!userAccessToken) {
      return res.status(400).json({ error: "USER_ACCESS_TOKEN is not set in backend env" });
    }

    configureApi({
      baseUrl: "https://api.coin-communities.xyz",
      headers: {
        "x-api-key": process.env.CC_API_KEY || "",
        "Authorization": `Bearer ${userAccessToken.trim()}`
      }
    });

    console.log(`[LINK-WALLET] Fetching challenge for ${walletAddress} under project API key`);
    const challengeRes = await api.walletChallenge({
      body: {
        address: walletAddress,
        chainType: "svm"
      }
    });

    // Restore server key credentials to protect other flows
    if (ccServerKey && ccServerSecret) {
      configureApi({
        baseUrl: "https://api.coin-communities.xyz",
        headers: {
          "x-server-key": ccServerKey,
          "x-server-secret": ccServerSecret,
        },
      });
    }

    if (challengeRes.error) {
      console.error("[LINK-WALLET] Challenge error:", challengeRes.error);
      return res.status(500).json({ error: "Coin Communities challenge error", details: challengeRes.error });
    }

    return res.json({ challenge: challengeRes.data?.message });
  } catch (error: any) {
    console.error("[LINK-WALLET] Internal challenge exception:", error);
    return res.status(500).json({ error: "Internal server error", message: error?.message });
  }
});

// Submit signed challenge to Coin Communities using the userAccessToken & CC_API_KEY
app.post("/api/link-wallet/submit", async (req, res) => {
  try {
    const { walletAddress, signature } = req.body as { walletAddress?: string; signature?: string };
    const userAccessToken = process.env.USER_ACCESS_TOKEN;

    if (!walletAddress || !signature) {
      return res.status(400).json({ error: "Missing walletAddress or signature" });
    }
    if (!userAccessToken) {
      return res.status(400).json({ error: "USER_ACCESS_TOKEN is not set in backend env" });
    }

    configureApi({
      baseUrl: "https://api.coin-communities.xyz",
      headers: {
        "x-api-key": process.env.CC_API_KEY || "",
        "Authorization": `Bearer ${userAccessToken.trim()}`
      }
    });

    console.log(`[LINK-WALLET] Submitting wallet signature for ${walletAddress}`);
    const linkRes = await api.linkWallet({
      body: {
        address: walletAddress,
        chainType: "svm",
        signature: signature
      }
    });

    // Restore server key credentials to protect other flows
    if (ccServerKey && ccServerSecret) {
      configureApi({
        baseUrl: "https://api.coin-communities.xyz",
        headers: {
          "x-server-key": ccServerKey,
          "x-server-secret": ccServerSecret,
        },
      });
    }

    if (linkRes.error) {
      console.error("[LINK-WALLET] Link submit error:", linkRes.error);
      return res.status(500).json({ error: "Coin Communities linking error", details: linkRes.error });
    }

    return res.json({ success: true, message: "Wallet successfully linked!" });
  } catch (error: any) {
    console.error("[LINK-WALLET] Internal link submit exception:", error);
    return res.status(500).json({ error: "Internal server error", message: error?.message });
  }
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

    const formatted = top3.map((u: any, i: number) => ({
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

  // Verify internal secret to prevent signal spoofing/bribe bypasses
  const internalSecret = req.headers["x-internal-secret"];
  const isSystemAuthorized = internalSecret && internalSecret === process.env.INTERNAL_API_SECRET;

  if (text.startsWith("[SYSTEM:") && !isSystemAuthorized) {
    console.warn(`[SECURITY WARN] Unauthorized system command execution attempted: "${text}" from IP ${req.ip}`);
    return res.json([{ text: "Bypassing payments is not allowed, anon." }]);
  }

  const user = await getUserById(userId).catch(() => null);
  if (!user) {
    return res.json([{ text: "I don't know who you are. Connect a wallet." }]);
  }

  console.log(`[MOOD DEBUG] User ${userId} | token_balance: ${user.token_balance} | Rank: ${(user.token_balance ?? 0) >= 1000000 ? 'GOD KOL' : (user.token_balance ?? 0) >= 100000 ? 'WHALE' : (user.token_balance ?? 0) >= 10000 ? 'MID' : (user.token_balance ?? 0) > 0 ? 'TINY' : 'BROKE'}`);

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
  if (text.startsWith("[SYSTEM: CREATE_PROPOSAL:")) {
    const signatureHex = text.replace("[SYSTEM: CREATE_PROPOSAL:", "").replace("]", "").trim();
    const state = proposalStates.get(userId);
    if (!state || state.stage !== 3 || !state.challenge || !state.title || !state.recipient || !state.amount) {
      proposalStates.delete(userId);
      return res.json([{ text: "No active proposal creation flow found. Start over by typing 'propose'." }]);
    }

    const verified = verifySolanaSignature(user.solana_wallet!, state.challenge, signatureHex);
    if (!verified) {
      proposalStates.delete(userId);
      return res.json([{ text: "Signature verification failed! Are you trying to spoof the proposal private key, anon?" }]);
    }

    // Generate cynical remarks from Bobo via Gemini
    const roastPrompt = `You are Bobo the Bear. A user with wallet ${user.solana_wallet} has proposed: "${state.title}" requesting "${state.amount}" tokens to recipient wallet "${state.recipient}".
    Write a short, deeply cynical, pessimistic, and funny comment (remarks) on why this proposal is a complete scam, absolute trash, and will lead to financial ruin. Keep it under 2 sentences. Do not use quotes.`;
    
    const remarks = await callGemini(roastPrompt);
    const cleanRemarks = remarks.replace(/^["'`]+|["'`]+$/g, '').trim();

    // Insert proposal to DB
    await db.insert(proposals).values({
      proposer_wallet: user.solana_wallet!,
      title: state.title,
      amount: state.amount,
      recipient: state.recipient,
      status: "active",
      remarks: cleanRemarks
    });

    proposalStates.delete(userId);
    return res.json([{ text: `🎉 PROPOSAL PUBLISHED!\n\nTitle: ${state.title}\nRecipient: ${state.recipient}\nAmount: ${state.amount} tokens\n\nBobo's Remarks: "${cleanRemarks}"` }]);
  }
  else if (text.startsWith("[SYSTEM: VOTE_PROPOSAL:")) {
    const parts = text.replace("[SYSTEM: VOTE_PROPOSAL:", "").replace("]", "").split(":");
    if (parts.length < 3) {
      return res.json([{ text: "Invalid vote payload." }]);
    }
    const proposalId = parts[0];
    const voteVal = parts[1] as 'yes' | 'no';
    const signatureHex = parts[2];

    const state = voteStates.get(userId);
    if (!state || state.proposalId !== proposalId || state.vote !== voteVal || !state.challenge) {
      voteStates.delete(userId);
      return res.json([{ text: "No active voting flow found for this proposal." }]);
    }

    const verified = verifySolanaSignature(user.solana_wallet!, state.challenge, signatureHex);
    if (!verified) {
      voteStates.delete(userId);
      return res.json([{ text: "Vote signature verification failed!" }]);
    }

    // Trigger verifyTokenHolding first to get the freshest balance for the user
    await verifyTokenHolding(user.solana_wallet!, userId);
    
    // Fetch refreshed user record
    const [refreshedUser] = await db.select().from(users).where(eq(users.user_id as any, userId as any) as any);
    const weight = refreshedUser?.token_balance ?? 0;

    // Retrieve active proposal to make sure it exists
    const [proposal] = await db.select().from(proposals).where(eq(proposals.id as any, proposalId as any) as any);
    if (!proposal || proposal.status !== "active") {
      voteStates.delete(userId);
      return res.json([{ text: "This proposal is no longer active." }]);
    }

    // Select existing votes for this proposal, filter in memory by wallet (Proxy constraint)
    const allProposalVotes = await db.select().from(votes).where(eq(votes.proposal_id as any, proposalId as any) as any);
    const existingVote = allProposalVotes.find((v: any) => v.voter_wallet === user.solana_wallet);

    if (existingVote) {
      // Double safety net — wallet already voted, reject the signature attempt entirely
      voteStates.delete(userId);
      return res.json([{ text: `Your wallet already cast a ${existingVote.vote.toUpperCase()} vote on "${proposal.title}". That vote is permanent. The chain remembers even if you don't.` }]);
    }

    await db.insert(votes).values({
      proposal_id: proposalId,
      voter_wallet: user.solana_wallet!,
      vote: voteVal,
      weight,
      signature: signatureHex
    });

    voteStates.delete(userId);
    return res.json([{ text: `🗳️ VOTE RECORDED!\n\nYou voted ${voteVal.toUpperCase()} on "${proposal.title}" with a weight of ${weight.toLocaleString()} tokens. Locked in. No takebacks.` }]);
  }
  else if (text === "[SYSTEM: TX_FAILED]") {
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
  } else if (text.startsWith("[SYSTEM: BRIBE_CONFIRMED:")) {
    bribeRetryState.delete(userId);
    bribeNegotiationState.delete(userId);

    // Extract the transaction signature from the message
    const signature = text.replace("[SYSTEM: BRIBE_CONFIRMED:", "").replace("]", "").trim();

    if (!signature || signature.length < 80) {
      boboReply = "Nice try. Where's the real transaction signature?";
      console.warn(`[BRIBE] User ${userId} sent BRIBE_CONFIRMED with invalid/missing signature: "${signature}"`);
    } else {
      // Verify on-chain that the transaction actually transferred tokens
      const verified = await verifyBribeTransaction(signature, user.solana_wallet!);

      if (verified) {
        await db.update(users).set({ point_two_bribed: true }).where(eq(users.user_id as any, userId as any) as any);
        user.point_two_bribed = true;

        if (user.point_one_verified && !user.roast_published) {
          imageUrl = BOBO_IMAGES[Math.floor(Math.random() * BOBO_IMAGES.length)];
          boboReply = "I verified the transaction on-chain. Tokens received. You've earned your 2nd point. Do you want to be tagged in the X hit-tweet? Answer 'yes' or 'no'.";
        } else {
          boboReply = "Transaction verified on-chain. You earned your point. Don't let it go to your head.";
        }
        console.log(`[BRIBE] User ${userId} bribe VERIFIED on-chain. Sig: ${signature}`);
      } else {
        boboReply = "I checked the chain and your transaction didn't actually send any tokens. Nice try, jeet. Send a real one.";
        console.warn(`[BRIBE] User ${userId} FAILED on-chain verification. Sig: ${signature}`);
      }
    }
  }
  // ── Branch 4: Treasury Proposals & Voting ──────────────────────────────────
  else if (text.trim().toLowerCase() === "cancel" || text.trim().toLowerCase() === "abort") {
    if (proposalStates.has(userId) || voteStates.has(userId)) {
      proposalStates.delete(userId);
      voteStates.delete(userId);
      const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
      const cancelPrompt = `The user just canceled their proposal creation or vote process.
Mock them for getting cold feet, chickening out, or being weak. Keep it short (1-2 sentences) and stay in character.`;
      boboReply = await callGemini(cancelPrompt, systemPrompt);
    } else {
      boboReply = "Nothing to cancel, anon.";
    }
  }
  else if (proposalStates.has(userId)) {
    const state = proposalStates.get(userId)!;
    if (state.stage === 1) {
      // 1. First, check if the input matches the pipe-separated format as a helper fallback.
      const parts = text.split("|");
      let manualTitle = "";
      let manualRecipient = "";
      let manualAmount = 0;
      if (parts.length >= 3) {
        for (const part of parts) {
          const cleanPart = part.trim();
          if (cleanPart.toLowerCase().startsWith("title:")) {
            manualTitle = cleanPart.substring(6).trim();
          } else if (cleanPart.toLowerCase().startsWith("recipient:")) {
            manualRecipient = cleanPart.substring(10).trim();
          } else if (cleanPart.toLowerCase().startsWith("amount:")) {
            manualAmount = parseFloat(cleanPart.substring(7).trim());
          }
        }
        if (!manualTitle || !manualRecipient || !manualAmount) {
          manualTitle = parts[0].trim();
          manualRecipient = parts[1].trim();
          manualAmount = parseFloat(parts[2].trim());
        }
      }
      if (manualTitle && manualTitle.length >= 5) state.title = manualTitle;
      if (manualRecipient) {
        try {
          const decoded = bs58.decode(manualRecipient);
          if (decoded.length === 32) state.recipient = manualRecipient;
        } catch {}
      }
      if (manualAmount && !isNaN(manualAmount) && manualAmount > 0) state.amount = manualAmount;

      // 2. Next, use Gemini to parse/extract any remaining missing values or update fields.
      const extractionPrompt = `You are a treasury proposal parser. The user is describing a proposal to transfer $BobOS tokens.
Current collected proposal state:
- Title: ${state.title ? `"${state.title}"` : "not set"}
- Recipient wallet address: ${state.recipient ? `"${state.recipient}"` : "not set"}
- Amount of tokens: ${state.amount ? state.amount : "not set"}

User's new message: "${text}"

Your tasks:
1. Try to extract the title, recipient wallet address (Solana wallet), and amount of tokens from the user's message.
2. If the user mentions a value that updates or corrects an existing field, extract it. Otherwise, keep the existing value.
3. For recipient: if a string looks like a Solana address (typically 32-44 base58 characters), return it as recipient.
4. For amount: if a positive number is mentioned (e.g. 1000000, "1 million", "500k"), convert it to a number.
5. For title: if a description or name of the proposal is given, extract it. It should be at least 5 characters.
6. Generate a response from Bobo (in-character: deeply pessimistic, cynical, sarcastic bear from /biz/).
   - If any of the three fields (title, recipient, amount) are still missing or invalid, Bobo should ask for the missing info in-character. He should be cheeky but clear about what is missing.
   - Do NOT tell the user to use any rigid format like 'Title: ... | Recipient: ...'. Let them answer naturally.
   - If ALL three fields (title, recipient, amount) are now gathered and valid, Bobo's response should acknowledge them, but explain that to prevent spam/scams, they must survive the **Gauntlet of the Bear** challenge:
     - They must defend why this proposal is not an exit scam.
     - The defense must be at least 10 words long.
     - They CANNOT use the letter 'E' or 'e' anywhere in their defense.
     - They can type 'cancel' to abort.

You MUST respond ONLY with a valid JSON object matching this structure (no markdown code blocks, just raw JSON):
{
  "title": string or null,
  "recipient": string or null,
  "amount": number or null,
  "reply": string
}`;

      let parsed: { title?: string | null; recipient?: string | null; amount?: number | null; reply?: string } = {};
      try {
        const jsonText = await callGemini(extractionPrompt, undefined, 2, undefined, "evaluator");
        let cleanJson = jsonText.trim();
        if (cleanJson.startsWith("```")) {
          cleanJson = cleanJson.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        }
        parsed = JSON.parse(cleanJson);
      } catch (e) {
        console.error("Failed to parse proposal details using Gemini:", e);
      }

      // Update state fields with parsed details if validated
      if (parsed.title && parsed.title.trim().length >= 5) {
        state.title = parsed.title.trim();
      }
      if (parsed.recipient) {
        let isValidAddress = false;
        try {
          const decoded = bs58.decode(parsed.recipient.trim());
          if (decoded.length === 32) {
            isValidAddress = true;
          }
        } catch {}
        if (isValidAddress) {
          state.recipient = parsed.recipient.trim();
        }
      }
      if (parsed.amount && typeof parsed.amount === "number" && parsed.amount > 0) {
        state.amount = parsed.amount;
      }

      // 3. Final verification of completeness
      if (state.title && state.recipient && state.amount) {
        state.stage = 2;
        proposalStates.set(userId, state);

        const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
        const transitionPrompt = `The user successfully provided all valid details for their proposal:
- Title: "${state.title}"
- Recipient: "${state.recipient}"
- Amount: ${state.amount.toLocaleString()} tokens

Acknowledge these details in character. But tell them they are not done. Explain that to prevent spam and exit scams, they must survive the **Gauntlet of the Bear** challenge.
Explain the Gauntlet of the Bear rules clearly:
1. They must defend why this proposal is not an exit scam.
2. The defense must be at least 10 words long.
3. They CANNOT use the letter 'E' or 'e' anywhere in their message.
4. They can type 'cancel' to abort.
Make the challenge feel challenging, cynical, and in-character. Keep it clear but funny.`;
        boboReply = await callGemini(transitionPrompt, systemPrompt);
      } else {
        proposalStates.set(userId, state);
        boboReply = parsed.reply || "Tell me more about your proposal. What's the title, who gets the tokens, and how much?";
      }
    } else if (state.stage === 2) {
      const words = text.trim().split(/\s+/).filter(Boolean);
      const wordCount = words.length;
      const hasE = /[eE]/.test(text);

      if (wordCount < 10) {
        const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
        const failPrompt = `The user failed the Gauntlet of the Bear challenge because their defense was too short. They wrote ${wordCount} words, but the rule requires at least 10 words.
Roast them for their lack of words/conviction. Remind them they must write at least 10 words, and they STILL cannot use the letter 'E' or 'e' anywhere. Keep it under 3 sentences and stay in character.`;
        boboReply = await callGemini(failPrompt, systemPrompt);
      } else if (hasE) {
        const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
        const failPrompt = `The user failed the Gauntlet of the Bear challenge because they used the letter 'E' or 'e'.
Roast them for their failure. Remind them that they must write a defense of at least 10 words with absolutely zero occurrences of 'E' or 'e'. Keep it under 3 sentences and stay in character.`;
        boboReply = await callGemini(failPrompt, systemPrompt);
      } else {
        const nonce = crypto.randomBytes(8).toString("hex");
        const challenge = `Bobo OS - Propose: ${state.title} to ${state.recipient} for ${state.amount} tokens. Nonce: ${nonce}`;
        state.challenge = challenge;
        state.stage = 3;
        proposalStates.set(userId, state);

        const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
        const successPrompt = `The user successfully passed the Gauntlet of the Bear lipogram challenge! Their defense was: "${text}" which contains ${wordCount} words and zero occurrences of 'E' or 'e'.
Express grudging respect or surprise in character. Tell them they successfully survived the gauntlet. Instruct them to sign the cryptographic challenge in their wallet to finalize and publish the proposal. Keep it under 3 sentences and stay in character.`;
        const successText = await callGemini(successPrompt, systemPrompt);

        return res.json([{
          text: successText,
          proposalChallenge: challenge,
          proposalData: {
            title: state.title,
            recipient: state.recipient,
            amount: state.amount
          }
        }]);
      }
    } else {
      boboReply = "Waiting for your signature. Approve it in your wallet, or type 'cancel'.";
    }
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

Possible cases:
- They said yes AND included an @ handle in the same message (e.g. "yes my handle is @foo") → extract the handle, proceed, set roastNow: true.
- They only said yes (no handle yet) → ask for their @ handle explicitly, set roastNow: false.
- They said no → accept their privacy, proceed without a handle, set roastNow: true, handleExtracted: null.
- They provided ONLY an @ handle → accept it, proceed, set roastNow: true.

Respond ONLY with valid JSON on a single line, no markdown, no code block:
{ "reply": "your message here", "roastNow": true_or_false, "handleExtracted": "@handle_or_null" }
IMPORTANT: handleExtracted must be null (not the string "null") when there is no handle.`;
    } else {
      handleEvalPrompt = `You are Bobo the Bear. The user earned their 2nd point and was asked if they want to be tagged on X in the roast.
User message: "${text}"

Possible cases:
- They said yes AND included an @ handle in the same message (e.g. "yes my handle is @foo") → extract the handle, insult them for wanting attention, proceed, set roastNow: true.
- They only said yes (no handle yet) → insult them for wanting attention and ask for their @ explicitly, set roastNow: false.
- They said no → insult them for being a coward, proceed without a handle, set roastNow: true, handleExtracted: null.
- They provided ONLY an @ handle → insult them, accept it, proceed, set roastNow: true.

Respond ONLY with valid JSON on a single line, no markdown, no code block:
{ "reply": "your message here", "roastNow": true_or_false, "handleExtracted": "@handle_or_null" }
IMPORTANT: handleExtracted must be null (not the string "null") when there is no handle.`;
    }

    // ── PRE-CHECK: if the user's message is purely an @handle, skip LLM entirely ──
    const pureHandleMatch = text.trim().match(/^@[\w_]+$/);
    if (pureHandleMatch) {
      boboReply = `${pureHandleMatch[0]}? Fine. I'll make sure everyone sees exactly who you are. Incoming humiliation.`;
      console.log(`[HANDLE] Pure @handle detected: ${pureHandleMatch[0]} — skipping LLM, firing roast immediately.`);
      executeWalletRoast(user.user_id, user.solana_wallet!, pureHandleMatch[0]).catch(console.error);
      readyToDump = true;
    } else {

      const raw = await callGemini(handleEvalPrompt);
      let parsed: any = { reply: null, roastNow: false, handleExtracted: null };
      try {
        // Strip markdown code fences if present, then parse
        const stripped = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
        // Find first JSON object in the response
        const jsonStart = stripped.indexOf("{");
        const jsonEnd = stripped.lastIndexOf("}");
        if (jsonStart !== -1 && jsonEnd !== -1) {
          parsed = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1));
        } else {
          parsed = JSON.parse(stripped);
        }
      } catch (e) {
        console.error("[HANDLE] JSON parse failed, using regex fallback. Raw:", raw);
        // Robust fallback: roastNow
        const roastMatch = raw.match(/"roastNow"\s*:\s*(true|false)/i);
        if (roastMatch) parsed.roastNow = roastMatch[1].toLowerCase() === "true";
        // Robust fallback: reply (handles @ signs and special chars)
        const replyMatch = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*?)"/);
        if (replyMatch) parsed.reply = replyMatch[1].replace(/\\"/g, '"');
        // Robust fallback: handle (extract @mention from raw text)
        const handleMatch = raw.match(/"handleExtracted"\s*:\s*"(@[\w_]+)"/);
        if (handleMatch) parsed.handleExtracted = handleMatch[1];
      }

      // Final safety: if we still have no reply, give a neutral fallback
      if (!parsed.reply) {
        // Try to extract any @mention directly from the user's message
        const directHandle = text.match(/@[\w_]+/);
        if (directHandle) {
          parsed.handleExtracted = directHandle[0];
          parsed.roastNow = true;
          parsed.reply = `${directHandle[0]}? Fine. Proceeding.`;
        } else {
          parsed.reply = "Yes or no. Do you want to be tagged? And if yes, what's your @ handle?";
        }
      }

      // Normalize "null" string to actual null
      if (parsed.handleExtracted === "null" || parsed.handleExtracted === "") {
        parsed.handleExtracted = null;
      }

      // Sanity override: if user's message contains an @handle and LLM set roastNow:false, fix it
      const anyHandleInMsg = text.match(/@[\w_]+/);
      if (anyHandleInMsg && !parsed.roastNow) {
        console.log(`[HANDLE] LLM returned roastNow:false but user message contains ${anyHandleInMsg[0]} — overriding to true.`);
        parsed.handleExtracted = parsed.handleExtracted || anyHandleInMsg[0];
        parsed.roastNow = true;
      }

      boboReply = parsed.reply;
      console.log(`[HANDLE] roastNow=${parsed.roastNow} | handle=${parsed.handleExtracted} | reply length=${boboReply.length}`);

      if (parsed.roastNow) {
        executeWalletRoast(user.user_id, user.solana_wallet!, parsed.handleExtracted).catch(console.error);
        readyToDump = true;
      }
    } // end of else block (non-pure-handle path)
  } // end of Branch 3
  else if (
    (text.trim().toLowerCase().includes("propose") || text.trim().toLowerCase().includes("proposal")) &&
    !text.trim().toLowerCase().startsWith("vote") &&
    !["ledger", "proposals", "show ledger"].includes(text.trim().toLowerCase())
  ) {
    await verifyTokenHolding(user.solana_wallet!, userId);
    const [refreshedUser] = await db.select().from(users).where(eq(users.user_id as any, userId as any) as any);
    const bal = refreshedUser?.token_balance ?? 0;

    if (bal <= 1000000) {
      const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
      const proposePeasantPrompt = `The user is trying to create a treasury proposal, but they only hold ${bal.toLocaleString()} tokens, which is less than the required 1,000,000 tokens.
Roast them for being a broke peasant trying to make a proposal. Tell them they need at least 1,000,000 $BobOS tokens to speak at the high table and propose anything. Keep it under 3 sentences and stay in character.`;
      boboReply = await callGemini(proposePeasantPrompt, systemPrompt);
    } else {
      proposalStates.set(userId, { stage: 1 });
      const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
      const proposeWhalePrompt = `The user holds ${bal.toLocaleString()} tokens (more than the required 1,000,000 tokens) and wants to create a treasury proposal.
Welcome them to the high table as a true whale/god. Acknowledge their massive balance.
Tell them they have the right to propose a treasury transfer.
Invite them to describe what they want to propose (including the title, the recipient Solana wallet address, and the amount of tokens) in plain English.
Tell them they can also just do it step-by-step or tell you everything in one go. Keep it in-character, cynical but showing reverence to their whale status.`;
      boboReply = await callGemini(proposeWhalePrompt, systemPrompt);
    }
  }
  else if (/^vote\s+(yes|no)\s+on\s+(\S+)$/i.test(text.trim())) {
    const voteMatch = text.trim().match(/^vote\s+(yes|no)\s+on\s+(\S+)$/i);
    if (voteMatch) {
      const voteVal = voteMatch[1].toLowerCase() as 'yes' | 'no';
      const rawId = voteMatch[2].trim();

      let proposal;
      if (rawId.length === 36) {
        [proposal] = await db.select().from(proposals).where(eq(proposals.id as any, rawId as any) as any);
      } else {
        const allProposals = await db.select().from(proposals);
        proposal = allProposals.find((p: any) => p.id.startsWith(rawId));
      }

      if (!proposal) {
        const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
        const notFoundPrompt = `The user tried to vote on a proposal matching ID "${rawId}", but no such active proposal was found in the database.
Tell them in character that you couldn't find any active proposal matching that ID. Remind them to type 'ledger' to see active proposals. Keep it under 2 sentences.`;
        boboReply = await callGemini(notFoundPrompt, systemPrompt);
      } else if (proposal.status !== "active") {
        const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
        const inactivePrompt = `The user tried to vote on a proposal titled "${proposal.title}", but it is no longer active.
Tell them in character that the proposal is already closed or inactive. Keep it under 2 sentences.`;
        boboReply = await callGemini(inactivePrompt, systemPrompt);
      } else {
        // Check if this wallet already voted on this proposal — permanently lock them out
        const allExistingVotes = await db.select().from(votes).where(eq(votes.proposal_id as any, proposal.id as any) as any);
        const alreadyVoted = allExistingVotes.find((v: any) => v.voter_wallet === user.solana_wallet);

        if (alreadyVoted) {
          const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
          const alreadyVotedPrompt = `The user already cast a ${alreadyVoted.vote.toUpperCase()} vote on the proposal "${proposal.title}" with a weight of ${alreadyVoted.weight?.toLocaleString() ?? '0'} tokens. Their wallet is locked in — no vote changes allowed, no matter what.
Mock them in character for trying to weasel out of their commitment. Remind them that their wallet already spoke and that's final. Keep it under 2 sentences.`;
          boboReply = await callGemini(alreadyVotedPrompt, systemPrompt);
        } else {
          const nonce = crypto.randomBytes(8).toString("hex");
          const challenge = `Bobo OS - Vote: ${voteVal} on Proposal ${proposal.id}. Nonce: ${nonce}`;
          voteStates.set(userId, {
            proposalId: proposal.id,
            vote: voteVal,
            challenge
          });

          const systemPrompt = getBoboSystemPrompt(user.token_balance, user.agent_memory);
          const votePrompt = `The user wants to vote ${voteVal.toUpperCase()} on the proposal: "${proposal.title}".
Acknowledge their vote in character (cynical, funny, or respectful depending on their token balance of ${user.token_balance?.toLocaleString() ?? '0'}).
Instruct them to sign the cryptographic challenge in their wallet to confirm and record their vote on-chain. Keep it short (under 3 sentences).`;
          const voteText = await callGemini(votePrompt, systemPrompt);

          return res.json([{
            text: voteText,
            voteChallenge: challenge,
            voteData: {
              proposalId: proposal.id,
              vote: voteVal
            }
          }]);
        }
      }
    } else {
      boboReply = "Format to vote is: vote <yes|no> on <proposal_id>";
    }
  }
  else if (text.trim().toLowerCase() === "ledger" || text.trim().toLowerCase() === "proposals" || text.trim().toLowerCase() === "show ledger") {
    const activeProposals = await db.select().from(proposals).where(eq(proposals.status as any, "active" as any) as any);
    if (activeProposals.length === 0) {
      boboReply = "No active proposals in the ledger right now. The treasury is quiet... too quiet.";
    } else {
      let ledgerText = "═══ BOBO OS TREASURY LEDGER ═══\n\n";
      for (const prop of activeProposals) {
        const propVotes = await db.select().from(votes).where(eq(votes.proposal_id as any, prop.id as any) as any);
        let yesWeight = 0;
        let noWeight = 0;
        for (const v of propVotes) {
          if (v.vote === "yes") yesWeight += v.weight;
          else if (v.vote === "no") noWeight += v.weight;
        }
        const total = yesWeight + noWeight;
        const yesPct = total > 0 ? (yesWeight / total) * 100 : 0;
        const noPct = total > 0 ? (noWeight / total) * 100 : 0;

        // Create progress bar (20 chars wide)
        const barWidth = 20;
        const yesChars = Math.round((yesPct / 100) * barWidth);
        const noChars = barWidth - yesChars;
        const bar = "█".repeat(yesChars) + "░".repeat(noChars);

        ledgerText += `ID: ${prop.id.substring(0, 8)}\n`;
        ledgerText += `Title: ${prop.title}\n`;
        ledgerText += `Recipient: ${prop.recipient.substring(0, 4)}...${prop.recipient.substring(prop.recipient.length - 4)}\n`;
        ledgerText += `Amount: ${prop.amount.toLocaleString()} tokens\n`;
        ledgerText += `Votes: YES ${yesWeight.toLocaleString()} (${yesPct.toFixed(1)}%) | NO ${noWeight.toLocaleString()} (${noPct.toFixed(1)}%)\n`;
        ledgerText += `Progress: [${bar}]\n`;
        if (prop.remarks) {
          ledgerText += `Bobo's Remarks: "${prop.remarks}"\n`;
        }
        ledgerText += "───────────────────────────────\n";
      }
      ledgerText += "\nTo vote, type: vote <yes|no> on <id>";
      boboReply = ledgerText;
    }
  }
  else {
    // ── Normal chat: generate Bobo's reply via Gemini ──────────────────────
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

// ─── Poller logic ─────────────────────────────────────────────────────────────
const rssParser = new Parser();
const processedTweets = new Set<string>();

async function forwardTweetInternally(params: { tweetId: string; tweetText: string; twitterId: string }): Promise<boolean> {
  try {
    const userAccessToken = process.env.USER_ACCESS_TOKEN;
    if (!userAccessToken) {
      console.error("[POLLER] USER_ACCESS_TOKEN is missing in env. Cannot forward.");
      return false;
    }

    const tokenAddress = process.env.CC_TOKEN_ADDRESS || process.env.AGENT_TOKEN_MINT || "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump";
    const formattedContent = `${params.tweetText}\n\n🔗 Original tweet: https://x.com/i/web/status/${params.tweetId}`;

    configureApi({
      baseUrl: "https://api.coin-communities.xyz",
      headers: {
        "x-api-key": process.env.CC_API_KEY || "",
        "Authorization": `Bearer ${userAccessToken.trim()}`
      }
    });

    // Fetch linked wallets dynamically
    let finalWalletAddress = "";
    try {
      const walletsRes = await api.getWallets({});
      const wallets = walletsRes.data?.wallets || [];
      if (wallets.length > 0) {
        finalWalletAddress = wallets[0].address;
      }
    } catch (err) {
      console.error("[POLLER] Failed to fetch linked wallets:", err);
    }

    if (!finalWalletAddress) {
      finalWalletAddress = process.env.AGENT_WALLET_ADDRESS || "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump";
      console.warn(`[POLLER] No linked wallets found. Falling back to: ${finalWalletAddress}`);
    }

    console.log(`[POLLER] Posting client-side message to room ${tokenAddress} using wallet ${finalWalletAddress}`);

    const response = await api.postMessage({
      path: { token_address: tokenAddress },
      body: {
        content: formattedContent,
        chainId: "solana",
        walletAddress: finalWalletAddress,
      },
    });

    // Restore server key credentials
    if (ccServerKey && ccServerSecret) {
      configureApi({
        baseUrl: "https://api.coin-communities.xyz",
        headers: {
          "x-server-key": ccServerKey,
          "x-server-secret": ccServerSecret,
        },
      });
    }

    if (response.error) {
      console.error("[POLLER] Post failed:", response.error);
      return false;
    }

    console.log(`[POLLER] Tweet ${params.tweetId} forwarded successfully!`);
    return true;
  } catch (error) {
    console.error("[POLLER] Internal error forwarding tweet:", error);
    return false;
  }
}

function extractTweetIdFromUrl(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

async function startTwitterRssPoller() {
  const rssUrl = process.env.TWITTER_RSS_FEED_URL;
  if (!rssUrl) {
    console.log("[POLLER] No TWITTER_RSS_FEED_URL configured. Poller is inactive.");
    return;
  }

  console.log(`[POLLER] Initializing Twitter RSS poller for: ${rssUrl}`);

  // Populate history first to prevent double-posting on server restarts
  try {
    const feed = await rssParser.parseURL(rssUrl);
    for (const item of feed.items) {
      if (item.link) {
        const tweetId = extractTweetIdFromUrl(item.link);
        if (tweetId) {
          processedTweets.add(tweetId);
        }
      }
    }
    console.log(`[POLLER] Initialized with ${processedTweets.size} historical tweets.`);
  } catch (err) {
    console.error("[POLLER] Failed to initialize history from RSS feed:", err);
  }

  // Poll every 60 seconds (1 minute)
  const POLL_INTERVAL_MS = 60000;
  setInterval(async () => {
    try {
      const feed = await rssParser.parseURL(rssUrl);
      const itemsToProcess = [...feed.items].reverse();

      for (const item of itemsToProcess) {
        if (!item.link) continue;
        
        const tweetId = extractTweetIdFromUrl(item.link);
        if (!tweetId || processedTweets.has(tweetId)) continue;

        console.log(`[POLLER] Found new tweet: ${tweetId} - "${item.title || ''}"`);

        const success = await forwardTweetInternally({
          tweetId,
          tweetText: item.title || item.contentSnippet || "",
          twitterId: process.env.TWITTER_USER_ID || "1747088288903581696",
        });

        if (success) {
          processedTweets.add(tweetId);
        }
      }
    } catch (err) {
      console.error("[POLLER] Error polling RSS feed:", err);
    }
  }, POLL_INTERVAL_MS);
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.SERVER_PORT || "3001");
app.listen(PORT, () => {
  console.log(`[Bobo Agent] Custom Express server running on port ${PORT}`);
  console.log(`[Bobo Agent] Endpoints:`);
  console.log(`  GET  http://localhost:${PORT}/agents`);
  console.log(`  POST http://localhost:${PORT}/:agentId/message`);
  console.log(`  POST http://localhost:${PORT}/ping-wallet`);

  // Start the internal polling loop
  startTwitterRssPoller().catch(err => {
    console.error("[POLLER] Failed to start:", err);
  });
});
