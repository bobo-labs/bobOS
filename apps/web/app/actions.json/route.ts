import { NextResponse } from "next/server";

const ACTIONS_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, x-accept-blockchain-ids",
};

export async function GET() {
  const payload = {
    rules: [
      {
        pathPattern: "/tribute",
        apiPath: "/api/actions/tribute"
      },
      {
        pathPattern: "/api/actions/**",
        apiPath: "/api/actions/**"
      }
    ]
  };

  return NextResponse.json(payload, { headers: ACTIONS_CORS_HEADERS });
}

export async function OPTIONS() {
  return new Response(null, { headers: ACTIONS_CORS_HEADERS });
}
