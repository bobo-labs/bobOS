import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

const ACTIONS_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, x-accept-blockchain-ids",
};

// GET request: Describe the action metadata
export async function GET(req: NextRequest) {
  const host = req.nextUrl.origin;
  const payload = {
    icon: `${host}/images/dev-card.webp`,
    title: "Tribute to Bobo",
    description: "Your portfolio is going to zero. Write a message and pay a tribute to Bobo in $BOBO to get roasted or convince him to tweet.",
    label: "Send Tribute",
    links: {
      actions: [
        {
          label: "Bribe 1,000 Tokens",
          href: `/api/actions/tribute?amount=1000&message={message}`,
          parameters: [
            {
              name: "message",
              placeholder: "Write your message to Bobo (optional)...",
              required: false,
            },
          ],
        },
        {
          label: "Bribe 5,000 Tokens",
          href: `/api/actions/tribute?amount=5000&message={message}`,
          parameters: [
            {
              name: "message",
              placeholder: "Write your message to Bobo (optional)...",
              required: false,
            },
          ],
        },
        {
          label: "Bribe Custom",
          href: `/api/actions/tribute?amount={amount}&message={message}`,
          parameters: [
            {
              name: "amount",
              placeholder: "Enter custom token amount...",
              required: true,
            },
            {
              name: "message",
              placeholder: "Write your message to Bobo (optional)...",
              required: false,
            },
          ],
        },
      ],
    },
  };

  return NextResponse.json(payload, { headers: ACTIONS_CORS_HEADERS });
}

// OPTIONS preflight request
export async function OPTIONS() {
  return new Response(null, { headers: ACTIONS_CORS_HEADERS });
}

// POST request: Create and serialize the transaction
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const account = body.account;

    if (!account) {
      return NextResponse.json(
        { message: "Missing wallet account." },
        { status: 400, headers: ACTIONS_CORS_HEADERS }
      );
    }

    const url = new URL(req.url);
    const amountStr = url.searchParams.get("amount") || "1000";
    const amount = parseFloat(amountStr);
    const message = url.searchParams.get("message") || "";

    if (isNaN(amount) || amount <= 0) {
      return NextResponse.json(
        { message: "Invalid amount specified." },
        { status: 400, headers: ACTIONS_CORS_HEADERS }
      );
    }

    const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    const userWallet = new PublicKey(account);
    const mintPubkey = new PublicKey(
      process.env.AGENT_TOKEN_MINT || "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump"
    );
    const destinationWallet = new PublicKey(
      process.env.AGENT_WALLET_ADDRESS || "DdLPU183TS7HCDnbxmjXXZ3aJsUz2nQrXH4k3vsxTpJB"
    );

    // ── Find sender's token account with highest balance ──
    let senderTokenAccounts;
    try {
      senderTokenAccounts = await connection.getParsedTokenAccountsByOwner(userWallet, {
        mint: mintPubkey,
      });
    } catch (e) {
      return NextResponse.json(
        { message: "Failed to query wallet token accounts." },
        { status: 400, headers: ACTIONS_CORS_HEADERS }
      );
    }

    if (senderTokenAccounts.value.length === 0) {
      return NextResponse.json(
        { message: "You do not hold any tokens of the required mint." },
        { status: 400, headers: ACTIONS_CORS_HEADERS }
      );
    }

    // Pick the account with the highest balance
    const bestSenderAccount = senderTokenAccounts.value.reduce((best, curr) => {
      const bestAmt = BigInt(best.account.data.parsed.info.tokenAmount.amount);
      const currAmt = BigInt(curr.account.data.parsed.info.tokenAmount.amount);
      return currAmt > bestAmt ? curr : best;
    });

    const senderATA = bestSenderAccount.pubkey;
    const decimals = bestSenderAccount.account.data.parsed.info.tokenAmount.decimals;
    const senderRawBalance = BigInt(bestSenderAccount.account.data.parsed.info.tokenAmount.amount);
    const rawAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));
    const ownerProgramId = new PublicKey(bestSenderAccount.account.owner.toString());

    if (senderRawBalance < rawAmount) {
      return NextResponse.json(
        { message: "Insufficient token balance for this tribute." },
        { status: 400, headers: ACTIONS_CORS_HEADERS }
      );
    }

    const recipientATA = await getAssociatedTokenAddress(mintPubkey, destinationWallet, false, ownerProgramId);

    const transaction = new Transaction();

    // Check if the recipient's ATA exists; if not, create it
    try {
      await getAccount(connection, recipientATA, undefined, ownerProgramId);
    } catch {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          userWallet,
          recipientATA,
          destinationWallet,
          mintPubkey,
          ownerProgramId
        )
      );
    }

    // 1. Add Memo instruction so wallets display a descriptive title
    transaction.add(
      new TransactionInstruction({
        keys: [{ pubkey: userWallet, isSigner: true, isWritable: true }],
        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        data: Buffer.from(`Bobo OS - Tribute: ${amount} tokens`, "utf-8"),
      })
    );

    // 2. Add TransferChecked instruction
    transaction.add(
      createTransferCheckedInstruction(
        senderATA,
        mintPubkey,
        recipientATA,
        userWallet,
        rawAmount,
        decimals,
        [],
        ownerProgramId
      )
    );

    // Set recent blockhash and fee payer
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = userWallet;

    // Serialize transaction
    const serializedTx = transaction.serialize({ requireAllSignatures: false }).toString("base64");

    // Construct next URL callback (preserving message in query string)
    const host = req.nextUrl.origin;
    const nextUrl = new URL(`${host}/api/actions/tribute/next`);
    nextUrl.searchParams.set("amount", amount.toString());
    if (message) {
      nextUrl.searchParams.set("message", message);
    }

    const responsePayload = {
      transaction: serializedTx,
      message: `Sign transaction to send ${amount} tokens tribute to Bobo!`,
      links: {
        next: {
          type: "post",
          href: nextUrl.toString(),
        },
      },
    };

    return NextResponse.json(responsePayload, { headers: ACTIONS_CORS_HEADERS });
  } catch (err: any) {
    console.error("Blinks POST error:", err);
    return NextResponse.json(
      { message: err?.message || "Internal server error" },
      { status: 500, headers: ACTIONS_CORS_HEADERS }
    );
  }
}
