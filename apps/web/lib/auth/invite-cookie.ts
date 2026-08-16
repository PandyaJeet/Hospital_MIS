/**
 * Cookie name only, kept out of the `"use server"` module because a server-action
 * file may export nothing but async functions — and `proxy.ts` needs to read this
 * too, where server actions don't apply.
 */
export const INVITE_COOKIE = "hmis_invite";
