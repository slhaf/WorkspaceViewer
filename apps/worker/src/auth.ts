import type { Env } from "./env.js";
import { getUser } from "./repository.js";

export interface AuthenticatedUser {
  userId: string;
}

export async function resolveUser(env: Env, request: Request): Promise<AuthenticatedUser | Response> {
  const devUserId = env.DEV_USER_ID;
  const userId = request.headers.get("x-workspace-viewer-user") ?? devUserId;
  if (!userId) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
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

export function oauthPlaceholder(pathname: string): Response {
  return new Response(
    `Workspace Viewer OAuth route ${pathname} is reserved. Development mode uses DEV_USER_ID.`,
    {
      status: 501,
      headers: { "content-type": "text/plain; charset=utf-8" }
    }
  );
}
