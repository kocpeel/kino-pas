import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { IkonaBilet } from "@/components/ui/Ikony";
import { StatusSieci } from "@/components/uklad/StatusSieci";
import "./globals.css";

// Jeden krój, self-hosted przez next/font (bez zapytań do zewnętrznych serwerów i bez skoku layoutu).
const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Kino Pas · kasa biletowa", template: "%s · Kino Pas" },
  description: "Rezerwacja i zakup biletów do Kina Pas.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0d1220",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl" className={inter.variable}>
      <body>
        <a href="#tresc" className="przeskocz">
          Przejdź do treści
        </a>
        <header className="naglowek">
          <div className="kontener naglowek__wnetrze">
            <Link href="/" className="logo">
              <IkonaBilet rozmiar={26} className="logo__znak" />
              Kino Pas <span className="logo__dopisek">kasa biletowa</span>
            </Link>
          </div>
        </header>
        <main id="tresc" className="tresc">
          <div className="kontener">
            <div className="banery">
              <StatusSieci />
            </div>
            {children}
          </div>
        </main>
        <footer className="stopka">
          <div className="kontener">Kino Pas · Etap I: rezerwacja i zakup biletu (płatności w kolejnym etapie)</div>
        </footer>
      </body>
    </html>
  );
}
