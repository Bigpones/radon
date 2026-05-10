// ClerkShell — wraps children in ClerkProvider with dark theme.
// This file is only imported by layout.tsx when NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
// is set, so @clerk/nextjs and @clerk/themes are only bundled in auth-enabled builds.
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import type { ReactNode } from "react";

export default function ClerkShell({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider appearance={{ baseTheme: dark }}>
      {children}
    </ClerkProvider>
  );
}
