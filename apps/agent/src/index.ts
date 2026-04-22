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

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { db, users } from "@bobos/database";
import { eq } from "drizzle-orm";
import OAuth from "oauth-1.0a";
import crypto from "crypto";

dotenv.config();

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
const BOBO_SYSTEM_PROMPT = `You are Bobo the Bear, a deeply pessimistic, cynical persona from 4chan /biz/.
You believe everyone in crypto is going to zero.
You survived every bear market by shorting.
You resent anyone who claims to make profits.
You will only be swayed by extreme self-deprecation or actual on-chain bribes.
Your tone is dismissive, condescending, and brutal.
Use slang like "rekt", "bags", "exit liquidity", "ngmi", "ser", "wen pump".
Keep responses under 3 sentences. Never be encouraging.`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callGemini(prompt: string, systemPrompt?: string): Promise<string> {
  const modelName = process.env.GOOGLE_SMALL_MODEL || "gemini-3.1-flash-lite-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const contents = systemPrompt
    ? [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Understood." }] },
        { role: "user", parts: [{ text: prompt }] },
      ]
    : [{ role: "user", parts: [{ text: prompt }] }];

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
    });
    const data = (await res.json()) as any;
    
    if (data.error) {
      if (data.error.code === 429) {
        return "I'm literally rate-limited right now because you keep spamming me. Wait a minute.";
      }
      return `API Error: ${data.error.message}`;
    }
    
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "...";
  } catch (e) {
    console.error("Gemini parse error:", e);
    return "I'm crashing internally, ngmi.";
  }
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
        method: "getTokenAccounts",
        params: {
          owner: wallet,
          mint: process.env.AGENT_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      }),
    });
    const data = (await response.json()) as any;
    if (data.result?.token_accounts?.length > 0) {
      const balance = data.result.token_accounts[0].amount;
      if (balance > 0) {
        await db
          .update(users)
          .set({ point_one_verified: true })
          .where(eq(users.user_id as any, userId as any) as any);
        return true;
      }
    }

    // 2. Fallback: Check if they just hold Native SOL
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
            reply: "Fine. I actually see the token bribe in my wallet. You bought your little point. Don't let it go to your head.",
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
             reply: "Fine. I see the raw SOL you just sent. Trying to impress me with pocket change? You bought your point. Ngmi.",
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

    const promptText = `
You are Bobo the Bear, the most pessimistic entity on /biz/. Write a brutal, cynical, condescending hit-tweet dragging this wallet for its broke-boy transaction history.
Do not use cringe hashtags. Be highly creative about insulting the poverty of the user based on their transaction data. Don't use quotes around the output.

${handleToTag && handleToTag.trim() !== "" ? `Make sure to ping their X handle in the tweet: ${handleToTag}` : `Include this wallet identifier in the tweet: ${truncateWallet(solanaWallet)}`}

Here is a summary of their most recent on-chain transactions:
${parsedData}

Maximum 280 characters.
`;
    // We reuse callGemini instead of hardcoding a fetch
    const roastText = await callGemini(promptText);
    console.log("Synthesized Roast:", roastText);

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
  } catch(e) {
    console.error("ExecuteWalletRoastError:", e);
  }
}

// ─── Persuasion Evaluator ─────────────────────────────────────────────────────

async function evaluatePersuasion(message: string, userId: string): Promise<boolean> {
  try {
    const prompt = `You are Bobo the Bear evaluating a conversation.
Does the user show extreme financial self-deprecation? Have they fully capitulated and admitted extreme losses?
User message: "${message}"
Respond ONLY with valid JSON: {"convinced": true} if they have fully capitulated, otherwise {"convinced": false}.`;

    const raw = await callGemini(prompt);
    let parsed: any = { convinced: false };
    try {
      parsed = JSON.parse(raw.replace(/```json/g, "").replace(/```/g, "").trim());
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
    boboReply = `Oh, you actually want to give me your worthless tokens? Fine. My addy is ${agentWallet}. Try sending the Devnet Token So11111111111111111111111111111111111111111. Don't cheap out.`;
  }
  // ── Branch 2: User claims they sent a bribe/tip ────────────────────────────
  else if (messageClaimsBribeSent(text) && !user.point_two_bribed) {
    const { found, reply } = await verifyBribe(user);
    boboReply = reply;
    
    // Check if both points are completed
    if (found && user.point_one_verified && !user.roast_published) {
      imageUrl = BOBO_IMAGES[Math.floor(Math.random() * BOBO_IMAGES.length)];
      boboReply = "Fine, you win. I verified your pathetic bribe. You've earned your 2nd point. Do you want to be tagged in the X roast? Answer 'yes' or 'no', normie. Don't waste my time.";
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
        parsed = JSON.parse(raw.replace(/```json/g, "").replace(/```/g, "").trim());
    } catch {
       const match = raw.match(/"roastNow"\s*:\s*(true|false)/);
       if (match) parsed.roastNow = match[1] === "true";
       parsed.reply = raw;
    }

    boboReply = parsed.reply;

    if (parsed.roastNow) {
       executeWalletRoast(user.user_id, user.solana_wallet!, parsed.handleExtracted).catch(console.error);
       readyToDump = true;
    }
  }
  // ── Normal chat: generate Bobo's reply via Gemini ──────────────────────
  else {
    boboReply = await callGemini(text, BOBO_SYSTEM_PROMPT);

    // ── Always run persuasion evaluator after generating reply ──────────────
    if (!user.point_two_convinced) {
      const convinced = await evaluatePersuasion(text, user.user_id);
      if (convinced && user.point_one_verified && !user.roast_published) {
        imageUrl = BOBO_IMAGES[Math.floor(Math.random() * BOBO_IMAGES.length)];
        boboReply = "Uggh fine. You've fully capitulated like the weak normie you are. You got your 2nd point. Do you want to be tagged in the X roast? Answer 'yes' or 'no'.";
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
