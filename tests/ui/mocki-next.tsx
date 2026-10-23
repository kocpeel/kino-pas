// Wspólne mocki Next.js dla testów komponentów.

import type { ReactNode } from "react";
import { vi } from "vitest";

export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };

export const mockNavigation = () => ({ useRouter: () => router });

export const mockLink = () => ({
  default: ({ href, children, ...reszta }: { href: string; children: ReactNode }) => (
    <a href={href} {...reszta}>
      {children}
    </a>
  ),
});
