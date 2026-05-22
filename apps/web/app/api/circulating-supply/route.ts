import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    const { searchParams } = new URL(request.url);
    const mint = searchParams.get("mint") || process.env.NEXT_PUBLIC_AGENT_TOKEN_MINT || "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump";
    
    const apiKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY || "8fa9ea58-61b4-4cce-a628-2e9af7c28659";
    const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenSupply",
        params: [mint],
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.result && data.result.value) {
        const circulatingSupply = data.result.value.uiAmount;
        if (typeof circulatingSupply === "number") {
          if (searchParams.get("format") === "text" || searchParams.get("plain") === "true") {
            return new Response(circulatingSupply.toString(), { headers: { ...headers, "Content-Type": "text/plain" } });
          }
          return NextResponse.json({ circulatingSupply }, { headers });
        }
      }
    }

    throw new Error("Failed to retrieve token supply from RPC");
  } catch (error) {
    console.error("Circulating supply API error:", error);
    
    const { searchParams } = new URL(request.url);
    const mint = searchParams.get("mint") || process.env.NEXT_PUBLIC_AGENT_TOKEN_MINT || "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump";
    
    let circulatingSupply = 1000000000;
    if (mint === "BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump") {
      circulatingSupply = 999999927.698531;
    }
    
    if (searchParams.get("format") === "text" || searchParams.get("plain") === "true") {
      return new Response(circulatingSupply.toString(), { headers: { ...headers, "Content-Type": "text/plain" } });
    }
    return NextResponse.json({ circulatingSupply }, { headers });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
