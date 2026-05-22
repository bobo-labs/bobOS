"use server";

import { db, users } from "@bobos/database";
import { eq } from "drizzle-orm";

export async function getUserState(walletAddress: string) {
  if (!walletAddress) return null;
  const [user] = await db.select().from(users).where(eq(users.solana_wallet, walletAddress));
  
  if (!user) {
    // Insert user if they connect for the first time
    const [newUser] = await db.insert(users).values({ 
      solana_wallet: walletAddress,
      point_one_verified: false,
      point_two_convinced: false,
      point_two_bribed: false,
      roast_published: false
    }).returning();
    return newUser;
  }
  // Cooldown logic check
  if (user.roast_published && user.last_roast_published_at) {
    let publishedAt = new Date(user.last_roast_published_at).getTime();
    // Adjust for postgres timezone stripping locally
    publishedAt += new Date().getTimezoneOffset() * 60000;
    const diffMs = Date.now() - publishedAt;
    const cooldownSeconds = parseInt(process.env.NEXT_PUBLIC_COOLDOWN_TIME || "21600", 10);
    const cooldownMs = cooldownSeconds * 1000;
    if (diffMs >= cooldownMs) {
       // Reset user to play again (they keep point 1 if they still hold tokens, but must earn point 2 again)
       const [updatedUser] = await db.update(users).set({ 
         roast_published: false,
         point_two_bribed: false,
         point_two_convinced: false
       }).where(eq(users.solana_wallet, walletAddress)).returning();
       return updatedUser;
    }
  }

  return user;
}

export async function pingAgentForWallet(walletAddress: string) {
  try {
    const agentUrl = process.env.AGENT_URL ?? "http://localhost:3001";
    await fetch(`${agentUrl}/ping-wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress }),
    });
  } catch (e) {
    console.error("Silent Ping Error:", e);
  }
}


export async function submitChat(walletAddress: string, message: string) {
  if (!walletAddress || !message) return { reply: "Speak up.", convinced: false };

  let replyText = "I'm ignoring you right now.";
  let replyImage: string | undefined = undefined;
  let convincedOrBribed = false;
  let isReadyToDump = false;
  let bribeAmount: number | undefined = undefined;
  let bribeWallet: string | undefined = undefined;
  let bribeMint: string | undefined = undefined;
  let openJupiter = false;

  let proposalChallenge = undefined;
  let proposalData = undefined;
  let voteChallenge = undefined;
  let voteData = undefined;

  try {
    // 1. Get user UUID from wallet address (single DB query — removed the redundant second query)
    const [user] = await db.select().from(users).where(eq(users.solana_wallet, walletAddress));
    if (!user) {
      return { reply: "Connect your wallet first.", convinced: false };
    }

    const agentUrl = process.env.AGENT_URL ?? "http://localhost:3001";
    const agentId = "bobo-the-bear";

    // 2. Post the user's message to the agent
    // Note: No /agents health-check ping here — it added a full roundtrip on every message.
    // If the agent is down, the fetch below will throw and be caught by the catch block.
    const messageRes = await fetch(`${agentUrl}/${agentId}/message`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-internal-secret": process.env.INTERNAL_API_SECRET || ""
      },
      body: JSON.stringify({ 
         text: message,
         userId: user.user_id,
         roomId: `room-${user.user_id}`,
         userName: "human"
      })
    });

    if (messageRes.ok) {
      const messagesArray = await messageRes.json();
      if (Array.isArray(messagesArray) && messagesArray.length > 0) {
         replyText = messagesArray.map((m: any) => m.text).join("\n");
         replyImage = messagesArray.find((m: any) => !!m.image)?.image;
         isReadyToDump = !!messagesArray.find((m: any) => !!m.readyToDump)?.readyToDump;
         const bribeMsg = messagesArray.find((m: any) => m.bribeAmount !== undefined);
         if (bribeMsg) {
           bribeAmount = bribeMsg.bribeAmount;
           bribeWallet = bribeMsg.bribeWallet;
           bribeMint = bribeMsg.bribeMint;
         }
         const jupiterMsg = messagesArray.find((m: any) => !!m.openJupiter);
         openJupiter = jupiterMsg ? true : false;
         // convincedOrBribed is derived from readyToDump signal — no second DB query needed
         convincedOrBribed = isReadyToDump;

         const propMsg = messagesArray.find((m: any) => m.proposalChallenge !== undefined);
         if (propMsg) {
           proposalChallenge = propMsg.proposalChallenge;
           proposalData = propMsg.proposalData;
         }
         const voteMsg = messagesArray.find((m: any) => m.voteChallenge !== undefined);
         if (voteMsg) {
           voteChallenge = voteMsg.voteChallenge;
           voteData = voteMsg.voteData;
         }
      }
    } else {
      replyText = "The agent choked on its response.";
    }

  } catch (e) {
    console.error("Chat Server Action Error:", e);
    replyText = "The agent is unreachable. Make sure it's running.";
  }

  let jupiterUrl = undefined;
  if (openJupiter) {
    const mint = process.env.AGENT_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    jupiterUrl = `https://jup.ag/?sell=So11111111111111111111111111111111111111112&buy=${mint}`;
  }

  return { 
    reply: replyText, 
    image: replyImage, 
    convinced: convincedOrBribed, 
    readyToDump: isReadyToDump, 
    bribeAmount, 
    bribeWallet, 
    bribeMint, 
    jupiterUrl,
    proposalChallenge,
    proposalData,
    voteChallenge,
    voteData
  };
}

export async function wipeUserProgress(walletAddress: string) {
  if (!walletAddress) return;
  await db.update(users).set({
    point_one_verified: false,
    point_two_convinced: false,
    point_two_bribed: false,
    token_balance: 0,
    persuasion_attempts: 0
  }).where(eq(users.solana_wallet, walletAddress));

  // Clear in-memory chat history on the agent server
  try {
    const agentUrl = process.env.AGENT_URL ?? "http://localhost:3001";
    await fetch(`${agentUrl}/clear-history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress }),
    });
  } catch (e) {
    console.error("Failed to clear agent chat history:", e);
  }
}

export async function getLeaderboard(): Promise<{ rank: number; wallet: string; roasts_count: number }[]> {
  try {
    const agentUrl = process.env.AGENT_URL ?? "http://localhost:3001";
    const res = await fetch(`${agentUrl}/leaderboard`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return data.leaderboard ?? [];
  } catch (e) {
    console.error("Failed to fetch leaderboard:", e);
    return [];
  }
}

export async function getWalletDeGeneracyStats(walletAddress: string) {
  if (!walletAddress) {
    return {
      success: false,
      error: "Wallet address is required"
    };
  }

  // 1. Generate seed/deterministic stats
  const hash = hashString(walletAddress);
  
  // Deterministic values based on wallet hash (fallbacks)
  const deterministicTrades = (hash % 380) + 20; // 20 to 400
  const deterministicGas = ((hash % 120) + (hash % 10) / 10 + 0.05); // 0.05 to 120.95 SOL
  const deterministicRugs = (hash % 15) + 1; // 1 to 16
  const deterministicJeetSwaps = (hash % 30) + 2; // 2 to 32 swaps
  const deterministicWinRate = (hash % 35) + 15; // 15% to 50%

  let gasSpent = parseFloat(deterministicGas.toFixed(4));
  let jeetIndex = deterministicJeetSwaps;
  let rugsTouched = deterministicRugs;
  let winRate = deterministicWinRate;
  let lifetimeTrades: string | number = deterministicTrades;
  
  let grade = "C";
  let description = "Average degen. Buys high, sells low, but keeps some dignity.";
  let memeUrl = "https://bobomemes.com/Images/bobo-the-bear-eating-mcdonalds.webp";

  // 2. Attempt to query Helius API for real data
  let usingRealData = false;
  let totalTradesCount = 0;
  let hasMoreTrades = false;

  // Token ownership flags (free — computed from balances we fetch anyway)
  const agentMint = process.env.NEXT_PUBLIC_AGENT_TOKEN_MINT || "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump";
  const boboMint = process.env.NEXT_PUBLIC_BOBO_TOKEN_MINT || "4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump";
  let holdsAgent = false;
  let holdsBobo = false;

  try {
    const apiKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY || "8fa9ea58-61b4-4cce-a628-2e9af7c28659";
    const isDevnet = process.env.NEXT_PUBLIC_HELIUS_RPC_URL?.includes("devnet");
    const baseUrl = isDevnet ? "https://api-devnet.helius.xyz" : "https://api.helius.xyz";
    const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    // A. Fetch Balances
    let balances: any[] = [];
    try {
      const balanceUrl = `${baseUrl}/v1/wallet/${walletAddress}/balances?api-key=${apiKey}`;
      const res = await fetch(balanceUrl);
      if (res.ok) {
        const data = await res.json();
        balances = data.balances || [];
        usingRealData = true;

        // Check token ownership from the same balances response — zero extra credits
        holdsAgent = balances.some(t => t.mint === agentMint && t.balance > 0);
        holdsBobo = balances.some(t => t.mint === boboMint && t.balance > 0);
      }
    } catch (err) {
      console.error("Balances API error:", err);
    }

    // B. Fetch Signatures (first page, limit 1000) for exact trade counts
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignaturesForAddress",
          params: [walletAddress, { limit: 1000 }]
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.result) {
          totalTradesCount = data.result.length;
          if (totalTradesCount === 1000) {
            hasMoreTrades = true;
          }
          usingRealData = true;
        }
      }
    } catch (err) {
      console.error("RPC getSignaturesForAddress error:", err);
    }

    // C. Fetch last 100 transactions for detailed swap & fee analysis
    let realFees = 0;
    let feePayingTxs = 0;
    let realSwaps = 0;
    try {
      const txUrl = `${baseUrl}/v0/addresses/${walletAddress}/transactions?api-key=${apiKey}&limit=100`;
      const res = await fetch(txUrl);
      if (res.ok) {
        const txs = await res.json();
        if (Array.isArray(txs) && txs.length > 0) {
          txs.forEach(tx => {
            if (tx.feePayer === walletAddress) {
              realFees += tx.fee || 0;
              feePayingTxs++;
            }
            if (tx.type === "SWAP" || (tx.source && tx.source.toLowerCase() === "jupiter")) {
              realSwaps++;
            }
          });
          usingRealData = true;
        }
      }
    } catch (err) {
      console.error("Transactions API error:", err);
    }

    // D. Process real metrics if we successfully pulled data
    if (usingRealData) {
      lifetimeTrades = hasMoreTrades ? "1,000+" : `${totalTradesCount}`;

      // Gas spent estimation based on average fee of last 100 transactions
      const averageFee = feePayingTxs > 0 ? (realFees / feePayingTxs) : 8000; // default 8000 lamports
      const tradesMultiplier = hasMoreTrades ? 1500 : totalTradesCount;
      gasSpent = parseFloat(((averageFee / 1e9) * tradesMultiplier).toFixed(4));

      // Scale swaps index to match trade scale
      const scaledJeetIndex = realSwaps * (tradesMultiplier / 100);
      jeetIndex = Math.max(Math.round(scaledJeetIndex), realSwaps);

      // Rugs Touched: Balance > 0 but zero/low liquidity (null price or usd value)
      const activeRugs = balances.filter(t => 
        t.mint !== "So11111111111111111111111111111111111111111" && 
        t.balance > 0 && 
        (t.usdValue === null || t.pricePerToken === null || t.pricePerToken === 0)
      ).length;
      rugsTouched = activeRugs;

      // Win Rate calculation based on profitable vs rugged holdings
      const activeProfitableTokens = balances.filter(t => 
        t.mint !== "So11111111111111111111111111111111111111111" && 
        t.balance > 0 && 
        t.usdValue > 0
      ).length;

      let calculatedWinRate = 35 + (activeProfitableTokens * 5) - (activeRugs * 3);
      calculatedWinRate += (hash % 11) - 5;
      winRate = Math.max(5, Math.min(95, calculatedWinRate));
    }
  } catch (e) {
    console.error("Helius stats fetch error, falling back to deterministic:", e);
  }

  // 3. Determine grade based on final calculated metrics
  if (usingRealData && totalTradesCount === 0) {
    grade = "N/A";
    description = "A clean slate. No trades detected. Either you just created this wallet or you're too scared of the chain.";
    memeUrl = "https://bobomemes.com/Images/bobo-the-bear-mcdonalds-worker-sad.webp";
  } else if (winRate >= 45) {
    grade = hash % 2 === 0 ? "A+" : "A";
    description = "Cigar-smoking mastermind. Frontrunning bots and laughing all the way to the bank.";
    memeUrl = "https://bobomemes.com/Images/bobo-the-bear-smoking-cigar-3d-smug.webp";
  } else if (winRate >= 35) {
    grade = "B";
    description = "Champagne degen. You hit a few green candles and now you think you're Michael Saylor.";
    memeUrl = "https://bobomemes.com/Images/bobo-the-bear-cheers-champagne-glass.webp";
  } else if (winRate >= 22) {
    grade = "C";
    description = "McDonald's Eater. Coping with losses by eating fries. Not completely rekt, but close.";
    memeUrl = "https://bobomemes.com/Images/bobo-the-bear-eating-mcdonalds.webp";
  } else {
    grade = hash % 2 === 0 ? "D" : "F";
    description = "Absolute wagecuck. Rekt on every single local top. Put on the McDonald's cap, anon.";
    memeUrl = "https://bobomemes.com/Images/bobo-the-bear-mcdonalds-worker-sad.webp";
  }

  const isOG = holdsAgent && holdsBobo;

  return {
    success: true,
    walletAddress,
    grade,
    description,
    memeUrl,
    stats: {
      gasSpent,
      jeetIndex,
      rugsTouched,
      lifetimeTrades,
      winRate
    },
    usingRealData,
    holdsAgent,
    holdsBobo,
    isOG
  };
}

export async function getMemeBase64(url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to fetch image");
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = res.headers.get("content-type") || "image/webp";
    const base64 = buffer.toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    console.error("Error in getMemeBase64:", error);
    return null;
  }
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
