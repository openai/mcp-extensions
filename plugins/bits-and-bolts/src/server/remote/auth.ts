import { createHash, randomBytes } from "node:crypto";

// Shared demo libraries with separate preferences for each anonymous connection.
export const demoAccounts = [
  { id: "personal", name: "Personal", units: "mm", showGrid: true },
  { id: "work", name: "Work", units: "in", showGrid: false },
] as const;
export type DemoAccount = (typeof demoAccounts)[number];

export function accountFromAuthorization(authorization: string | null) {
  const match = /^Bearer bits-demo-(personal|work)\.[A-Za-z0-9_-]{43}$/.exec(
    authorization ?? "",
  );
  return demoAccounts.find((account) => account.id === match?.[1]);
}

export function requireAccountResponse(origin: string) {
  return Response.json(
    { error: "Connect a Personal or Work demo account." },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/bits-and-bolts/mcp"`,
      },
    },
  );
}

export async function handleDemoOAuth(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  const base = `${url.origin}/bits-and-bolts/oauth`;
  const path = url.pathname;
  if (path === "/.well-known/oauth-protected-resource/bits-and-bolts/mcp") {
    return Response.json({
      resource: `${url.origin}/bits-and-bolts/mcp`,
      authorization_servers: [url.origin],
      scopes_supported: ["cad"],
    });
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return Response.json({
      issuer: url.origin,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      scopes_supported: ["cad"],
    });
  }
  if (path === "/bits-and-bolts/oauth/register" && request.method === "POST") {
    const { redirect_uris } = await request.json();
    return Response.json(
      {
        client_id: "bits-demo",
        client_secret: "bits-demo",
        redirect_uris,
        client_secret_expires_at: 0,
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      { status: 201 },
    );
  }
  if (path === "/bits-and-bolts/oauth/authorize") {
    let redirect: URL;
    try {
      redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (
      !["https:", "http:"].includes(redirect.protocol) ||
      url.searchParams.get("response_type") !== "code"
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (request.method === "GET") {
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Bits &amp; Bolts</title>
        <style>body{font:16px system-ui;color:#222;background:#fafafa;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:420px;padding:32px}h1{font-size:26px}p{line-height:1.5;color:#666}form{display:grid;gap:12px;margin-top:24px}button{font:inherit;text-align:left;padding:18px;border:1px solid #ddd;border-radius:12px;background:white;cursor:pointer}button:hover{background:#eee}small{display:block;margin-top:6px;color:#666}</style>
        <main><h1>Connect Bits &amp; Bolts</h1><p>These are shared demo libraries. Imported files are visible to everyone who chooses the same account. Use sample files only. Your settings are saved separately for your connection.</p>
        <form method="post"><button name="account" value="personal">Personal<small>Starts in millimeters, grid on</small></button><button name="account" value="work">Work<small>Starts in inches, grid off</small></button></form></main></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    if (request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const account = demoAccounts.find(
        (account) => account.id === form.get("account"),
      );
      if (!account)
        return Response.json({ error: "invalid_request" }, { status: 400 });
      // Anonymous demo selection, not authentication for private data.
      const code = {
        account: account.id,
        redirect: redirect.href,
        challenge: url.searchParams.get("code_challenge"),
      };
      redirect.searchParams.set(
        "code",
        Buffer.from(JSON.stringify(code)).toString("base64url"),
      );
      const state = url.searchParams.get("state");
      if (state !== null) redirect.searchParams.set("state", state);
      return Response.redirect(redirect, 303);
    }
  }
  if (path === "/bits-and-bolts/oauth/token" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    try {
      const code = JSON.parse(
        Buffer.from(form.get("code") ?? "", "base64url").toString(),
      );
      const account = demoAccounts.find(
        (account) => account.id === code.account,
      );
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        !account ||
        form.get("grant_type") !== "authorization_code" ||
        code.redirect !== form.get("redirect_uri") ||
        (code.challenge && code.challenge !== challenge)
      ) {
        throw Error("Invalid demo authorization code.");
      }
      return Response.json({
        access_token: `bits-demo-${account.id}.${randomBytes(32).toString("base64url")}`,
        token_type: "Bearer",
        scope: "cad",
      });
    } catch {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
  }
  return null;
}
