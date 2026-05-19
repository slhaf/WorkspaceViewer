import type { Env } from "./env.js";
import { getUser } from "./repository.js";
import { OAUTH_SCOPE } from "@workspace-viewer/protocol";

export interface AuthenticatedUser {
  userId: string;
}

export interface OAuthProps {
  userId?: unknown;
}

export async function resolveUser(
  env: Env,
  request: Request,
  props?: OAuthProps
): Promise<AuthenticatedUser | Response> {
  const oauthUserId = typeof props?.userId === "string" ? props.userId : undefined;
  const devBypass = env.DEV_AUTH_BYPASS_ENABLED === "true";
  const devUserId = devBypass ? env.DEV_USER_ID : undefined;
  const headerUserId = devBypass ? request.headers.get("x-workspace-viewer-user") ?? undefined : undefined;
  const userId = oauthUserId ?? headerUserId ?? devUserId;
  if (!userId) {
    return authenticationRequired(request);
  }

  const user = await getUser(env.DB, userId);
  if (!user) {
    return Response.json({ error: "unknown_user" }, { status: 401 });
  }
  if (user.status !== "active") {
    return Response.json({ error: "user_suspended" }, { status: 403 });
  }
  return { userId };
}

export function authenticationRequired(request: Request): Response {
  return Response.json(
    { error: "authentication_required" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": oauthChallenge(request)
      }
    }
  );
}

export function oauthChallenge(request: Request): string {
  const url = new URL(request.url);
  const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer resource_metadata="${metadataUrl}", scope="${OAUTH_SCOPE}"`;
}
