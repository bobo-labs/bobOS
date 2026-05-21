import { NextRequest, NextResponse } from "next/server";
import { getUserState, pingAgentForWallet, submitChat } from "../../../../actions";

const ACTIONS_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, x-accept-blockchain-ids",
};

export async function OPTIONS() {
  return new Response(null, { headers: ACTIONS_CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { signature, account } = body as { signature?: string; account?: string };

    if (!account) {
      return NextResponse.json(
        { message: "Missing wallet account." },
        { status: 400, headers: ACTIONS_CORS_HEADERS }
      );
    }

    if (!signature) {
      return NextResponse.json(
        { message: "Missing transaction signature." },
        { status: 400, headers: ACTIONS_CORS_HEADERS }
      );
    }

    const url = new URL(req.url);
    const message = url.searchParams.get("message") || "";

    // 1. Ensure user is created in the database
    await getUserState(account);

    // 2. Ping the agent to verify token balance and update DB
    await pingAgentForWallet(account);

    // 3. Confirm the bribe transaction signature with the agent
    const verifyRes = await submitChat(account, `[SYSTEM: BRIBE_CONFIRMED:${signature}]`);

    let finalReply = verifyRes.reply;
    let finalImage = verifyRes.image || "";

    const isFailed = finalReply.includes("didn't actually send") || finalReply.includes("Nice try");

    // 4. If the bribe succeeded and a custom message was entered, submit it to get a custom roast
    if (!isFailed && message.trim()) {
      const chatRes = await submitChat(account, message);
      finalReply = chatRes.reply;
      if (chatRes.image) {
        finalImage = chatRes.image;
      }
    }

    // 5. Convert relative image paths to absolute URLs for the Action spec
    const host = req.nextUrl.origin;
    let finalImageUrl = `${host}/images/dev-card.webp`; // Fallback image

    if (finalImage) {
      if (finalImage.startsWith("http")) {
        finalImageUrl = finalImage;
      } else {
        // Prepend host to relative path
        finalImageUrl = `${host}${finalImage.startsWith("/") ? "" : "/"}${finalImage}`;
      }
    }

    const responsePayload = {
      icon: finalImageUrl,
      title: isFailed ? "Verification Failed" : "Tribute Accepted!",
      description: finalReply,
      label: "Tribute Paid",
      disabled: true,
    };

    return NextResponse.json(responsePayload, { headers: ACTIONS_CORS_HEADERS });
  } catch (err: any) {
    console.error("Blinks nextAction POST error:", err);
    return NextResponse.json(
      { message: err?.message || "Internal server error" },
      { status: 500, headers: ACTIONS_CORS_HEADERS }
    );
  }
}
