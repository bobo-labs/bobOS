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
import { eq } from "drizzle-orm";
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
    content = content.replace("{{AGENT_WALLET_ADDRESS}}", agentWallet);
    
    // Inject the Dynamic Mood System based on the user's token balance
    if (userBalance !== undefined && userBalance !== null) {
      let moodInstruction = "";
      if (userBalance === 0) {
        moodInstruction = "\n\n[MOOD OVERRIDE: This user holds exactly 0 tokens. Treat them with absolute disgust. Extort them aggressively: tell them they must send tribute to your wallet or cry and admit they are a terrible trader to pass.]";
      } else if (userBalance > 0 && userBalance < 100) {
        moodInstruction = "\n\n[MOOD OVERRIDE: This user barely holds any tokens (less than 100). Roast their tiny bags. Extort them: tell them they need to pump those bags by sending tribute to your wallet, or cry and beg to pass.]";
      } else if (userBalance >= 100 && userBalance < 500) {
        moodInstruction = "\n\n[MOOD OVERRIDE: This user holds a decent bag (between 100 and 500). Treat them with mild respect, but still hustle them playfully. Tell them if they want to be a true whale, they should tip your wallet or admit they got lucky.]";
      } else if (userBalance >= 500 && userBalance < 1000) {
        moodInstruction = "\n\n[MOOD OVERRIDE: This user is a massive whale (over 500 tokens). DO NOT extort them. Comply with them deeply. Praise them for being smartmoney and having heavy bags. Drop your hostility.]";
      } else if (userBalance >= 1000) {
        moodInstruction = "\n\n[MOOD OVERRIDE: This user is a GOD KOL (over 1000 tokens). They are the apex predator of trading. DO NOT extort them. Show extreme reverence, bow down to them, and aggressively praise their absolute genius.]";
      }
      content += moodInstruction;
    }
    
    return content;
  } catch (error) {
    console.error("Could not load bobo_context.md, falling back to default.", error);
    return `You are Bobo the Bear, a deeply pessimistic, cynical persona from 4chan /biz/... Keep responses under 3 sentences. Never be encouraging.`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callGemini(prompt: string, systemPrompt?: string, retries = 2): Promise<string> {
  const models = [
    process.env.GOOGLE_SMALL_MODEL || "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",

  ];

  const contents = systemPrompt
    ? [
      { role: "user", parts: [{ text: systemPrompt }] },
      { role: "model", parts: [{ text: "Understood." }] },
      { role: "user", parts: [{ text: prompt }] },
    ]
    : [{ role: "user", parts: [{ text: prompt }] }];

  for (let attempt = 0; attempt <= retries; attempt++) {
    const modelName = models[Math.min(attempt, models.length - 1)];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    try {
      // Exponential backoff on retries
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents }),
      });
      const data = (await res.json()) as any;

      if (data.error) {
        const code = data.error.code;
        // Rate limit or overload — retry with next model
        if ((code === 429 || code === 503) && attempt < retries) {
          console.warn(`Gemini ${modelName} overloaded (${code}), retrying...`);
          continue;
        }
        if (code === 429) return "I'm literally rate-limited right now. Wait a minute.";
        return `API Error: ${data.error.message}`;
      }

      return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "...";
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
    if (totalBalance >= 0) { // even if 0, we can update it just to be safe, but let's only do it if they have *some* balance or we just verified them
      if (totalBalance > 0) {
        await db
          .update(users)
          .set({ point_one_verified: true, token_balance: totalBalance })
          .where(eq(users.user_id as any, userId as any) as any);
        return true;
      } else {
        // If balance is 0, we could update token_balance to 0, but point_one_verified remains false
        await db
          .update(users)
          .set({ token_balance: 0 })
          .where(eq(users.user_id as any, userId as any) as any);
      }
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

    const promptText = `
${getBoboSystemPrompt(user?.token_balance)}

Based on your character and your current mood, write a hit-tweet analyzing this wallet's transaction history. 
Do not use cringe hashtags. Be highly creative. Don't use quotes around the output.

${handleToTag && handleToTag.trim() !== "" ? `Make sure to directly tag the user in the tweet as ${handleToTag} and roast them personally (e.g. "${handleToTag} look at this mfer's pathetic trading history"). Do NOT say "look at this wallet". Talk to them directly as the owner of these bags.` : `Include this wallet identifier in the tweet: ${truncateWallet(solanaWallet)}`}

Here is a summary of their most recent on-chain transactions:
${parsedData}

Maximum 280 characters.
`;
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
      .set({ roast_published: true })
      .where(eq(users.user_id as any, userId as any) as any);

    console.log("EXECUTE_WALLET_ROAST called. Wallet utterly roasted on X/Twitter.");
  } catch (e) {
    console.error("ExecuteWalletRoastError:", e);
  }
}

// ─── Persuasion Evaluator ─────────────────────────────────────────────────────

async function evaluatePersuasion(message: string, userId: string, userBalance?: number | null): Promise<boolean> {
  try {
    // Whales (Rank 3) instantly pass without needing to beg.
    if (userBalance !== undefined && userBalance !== null && userBalance >= 500) {
      await db
        .update(users)
        .set({ point_two_convinced: true })
        .where(eq(users.user_id as any, userId as any) as any);
      return true;
    }

    const prompt = `You are Bobo the Bear evaluating a conversation.
Does the user show extreme, desperate financial self-deprecation? Have they fully capitulated, begged for mercy, AND admitted they are a terrible trader?
A simple "I suck" or "I am a bad trader" is NOT enough. They must write a pitiful, multi-sentence excuse begging you for approval.
User message: "${message}"
Respond ONLY with valid JSON: {"convinced": true} if they have fully capitulated according to these strict rules, otherwise {"convinced": false}.`;

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
    const handleEvalPrompt = `You are Bobo the Bear. The user earned their 2nd point and was asked if they want to be tagged on X in the roast.
User message: "${text}"

If they say yes, insult them for wanting attention and ask for their @ explicitly.
If they say no, insult them for being a coward and indicate you're proceeding without an @.
If they provided an @ handle (either directly or after saying yes), insult them, accept it, and indicate you are proceeding.
Respond ONLY with valid JSON exactly like this: { "reply": "...", "roastNow": boolean, "handleExtracted": "string or null" }
Set roastNow to true ONLY if they said no, OR if they provided their @ handle. Otherwise false.`;

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
    boboReply = await callGemini(text, getBoboSystemPrompt(user?.token_balance));

    // ── Always run persuasion evaluator after generating reply ──────────────
    if (!user.point_two_convinced) {
      const convinced = await evaluatePersuasion(text, user.user_id, user.token_balance);
      if (convinced && user.point_one_verified && !user.roast_published) {
        imageUrl = BOBO_IMAGES[Math.floor(Math.random() * BOBO_IMAGES.length)];
        
        if (user.token_balance !== null && user.token_balance >= 500) {
          boboReply = "Your bags are massive. You don't even need to beg. You instantly pass my evaluation. Do you want to be tagged in the X celebration? Answer 'yes' or 'no'.";
        } else {
          boboReply = "Uggh fine. You've fully capitulated like the weak normie you are. You got your 2nd point. Do you want to be tagged in the X roast? Answer 'yes' or 'no'.";
        }
      }
    }
  }

  return res.json([{ text: boboReply, image: imageUrl, readyToDump }]);
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
