import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// API routes are public at the middleware level because server-side page
// fetches don't carry Clerk session cookies. External API access is still
// protected by FastAPI's Clerk JWT auth middleware.
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/(.*)",
]);

// When NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set (local dev without auth),
// export a no-op middleware so Clerk never runs and no redirect occurs.
// Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY in web/.env to enable auth.
export default process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  ? clerkMiddleware(async (auth, request) => {
      if (!isPublicRoute(request)) {
        await auth.protect();
      }
    })
  : (_req: NextRequest) => NextResponse.next();

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
