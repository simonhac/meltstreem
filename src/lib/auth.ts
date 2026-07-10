import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "@/env";
import { timingSafeEqualStr } from "@/lib/ids";

// JWKS is cached across requests (module scope; jose also caches the fetched keys internally).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Verify a Cloudflare Access application JWT — the `Cf-Access-Jwt-Assertion` header Access injects into
 * requests it forwards to us after a successful login. We check the signature against the team's JWKS
 * plus the issuer and this app's audience (AUD). **Fail-closed**: returns false if the token is missing,
 * invalid, or the ACCESS_* config is absent — so /inspect + /api stay locked even if Access is disabled,
 * misconfigured, or bypassed. Presence alone is not trusted; the signature is what makes it unforgeable.
 */
export async function verifyAccessJwt(env: Env, token: string | undefined): Promise<boolean> {
  const issuer = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (!issuer || !audience || !token) return false;
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/cdn-cgi/access/certs`));
  try {
    await jwtVerify(token, jwks, { issuer, audience });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gate for the human inspection endpoints: a valid Access JWT, OR the explicit local-dev bypass
 * `DEV_SKIP_ACCESS` — which is only ever set in `.dev.vars` (never in wrangler.jsonc or a prod secret),
 * because `wrangler dev` has no Cloudflare Access in front of it. Fail-closed everywhere else.
 */
export async function accessOk(env: Env, token: string | undefined): Promise<boolean> {
  if (env.DEV_SKIP_ACCESS === "true") return true;
  return verifyAccessJwt(env, token);
}

/** Timing-safe check of an `Authorization: Bearer <token>` header against `expected`. */
export function checkBearer(
  authHeader: string | undefined,
  expected: string | undefined,
): "ok" | "unconfigured" | "denied" {
  if (!expected) return "unconfigured";
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  return m && timingSafeEqualStr(m[1]!, expected) ? "ok" : "denied";
}
