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
      headers: { "Content-Type": "application/json" },
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
         replyText = messagesArray.map((m: any) => m.text).join("\\n");
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
  
  return { reply: replyText, image: replyImage, convinced: convincedOrBribed, readyToDump: isReadyToDump, bribeAmount, bribeWallet, bribeMint, jupiterUrl };
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
