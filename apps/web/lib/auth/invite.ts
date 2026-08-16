"use server";

import { cookies } from "next/headers";

import { INVITE_COOKIE } from "./invite-cookie";

/**
 * Invite tokens are parked in a cookie, not localStorage, and the reason is the
 * confirm-email round trip.
 *
 * `mailer_autoconfirm` is **false** on this project, so redeeming an invite spans:
 * open link → sign up → leave the app to confirm → come back → sign in →
 * `accept_invite()`. The token has to survive all of that, and a cookie is the only
 * store `proxy.ts` can also read — which is what lets the proxy hand the token back
 * on the `pending` → `/onboarding` redirect instead of the user re-pasting it.
 */
export async function storeInviteToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return;
  const store = await cookies();
  store.set(INVITE_COOKIE, trimmed, {
    path: "/",
    // Long enough to confirm an email at leisure, shorter than the invite's own
    // 7-day expiry so a stale cookie cannot outlive what it refers to.
    maxAge: 60 * 60 * 24 * 3,
    sameSite: "lax",
    httpOnly: false,
  });
}

export async function clearInviteToken() {
  const store = await cookies();
  store.delete(INVITE_COOKIE);
}
