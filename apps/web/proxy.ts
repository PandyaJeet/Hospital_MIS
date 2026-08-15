import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { canAccess, homeFor, isPublicPath } from "@/lib/auth/route-access";
import { isRole, type Role } from "@/lib/roles";

/**
 * Route guard + session refresh.
 *
 * Next 16 renamed the `middleware` convention to `proxy`; the contracts still call
 * it middleware, which is the same thing.
 *
 * Two jobs:
 *  1. Refresh the Supabase auth cookie on each request. This is why the proxy
 *     exists with `@supabase/ssr` — Server Components cannot write cookies, so
 *     without this a session would expire mid-use.
 *  2. Keep a role off screens built for another role, and route a `pending` user
 *     to onboarding (auth-tenancy.md §7).
 *
 * This is navigational scoping. The real security boundary is Postgres RLS
 * (rules.md §1, §4) — never rely on this alone to protect data.
 */

/**
 * Mock mode has no cookie session, so guarding would make the whole app
 * unreachable in local development.
 *
 * The `NODE_ENV` half is deliberate and load-bearing: without it, setting
 * NEXT_PUBLIC_USE_MOCK=true in a deployed environment would silently disable
 * every route guard in production. A misconfigured env var must not be able to
 * turn authentication off.
 *
 * Consequence: mock mode works under `next dev` only. A production build will
 * enforce guards regardless, and since the mock "session" is module state rather
 * than a cookie, a deployed mock build simply bounces to /login. That is the
 * intended outcome — mock data must never be served to a real clinic.
 */
const MOCK_BYPASS =
  process.env.NEXT_PUBLIC_USE_MOCK === "true" &&
  process.env.NODE_ENV !== "production";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (MOCK_BYPASS) return NextResponse.next({ request });

  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without config we cannot establish a session. Fail closed: send everyone to
  // /login rather than letting unauthenticated traffic reach a role screen.
  if (!url || !key) {
    if (isPublicPath(pathname)) return response;
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    if (isPublicPath(pathname)) return response;
    const redirect = new URL("/login", request.url);
    return NextResponse.redirect(redirect);
  }

  // Signed in: resolve the role. Filter by id explicitly — an admin may read every
  // profile in their tenant, so an unfiltered query returns more than one row.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const role: Role = isRole(profile?.role ?? "") ? (profile!.role as Role) : "pending";

  // Already authenticated — no reason to sit on login/signup.
  if (isPublicPath(pathname)) {
    return NextResponse.redirect(new URL(homeFor(role), request.url));
  }

  // `pending` is a normal state, not an error, so never redirect-loop it.
  if (role === "pending") {
    if (pathname === "/onboarding") return response;
    return NextResponse.redirect(new URL("/onboarding", request.url));
  }

  // Onboarded users have no business back on onboarding.
  if (pathname === "/onboarding") {
    return NextResponse.redirect(new URL(homeFor(role), request.url));
  }

  if (pathname === "/") {
    return NextResponse.redirect(new URL(homeFor(role), request.url));
  }

  if (!canAccess(role, pathname)) {
    return NextResponse.redirect(new URL(homeFor(role), request.url));
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
