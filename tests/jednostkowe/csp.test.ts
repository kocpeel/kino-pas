import { describe, expect, it } from "vitest";
import { czyZadanieStrony, nowyNonce, politykaCsp, zadanieZCsp, zCspNaOdpowiedzi } from "../../src/lib/http/csp";

describe("Content-Security-Policy", () => {
  it("produkcja: nonce + strict-dynamic, bez unsafe-inline/unsafe-eval dla skryptów", () => {
    const csp = politykaCsp({ nonce: "abc123==", https: true, host: "kasa.example" });
    expect(csp).toContain("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("connect-src 'self' wss://kasa.example");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("bez HTTPS (preview na localhost) nie podnosi zasobów do https i używa ws:", () => {
    const csp = politykaCsp({ nonce: "x", https: false, host: "localhost:8790" });
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(csp).toContain("ws://localhost:8790");
  });

  it("tryb dev: bez nonce'a, z eval dla Reacta i z Workerem sali", () => {
    const csp = politykaCsp({ https: false, dodatkowePolaczenia: ["ws://localhost:*"] });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' ws://localhost:*");
  });

  it("nonce jest losowy i w formacie, który Next.js rozpozna", () => {
    const a = nowyNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(nowyNonce()).not.toBe(a);
  });

  it("nonce dostają tylko strony, nie API ani pliki", () => {
    const zadanie = (sciezka: string, method = "GET") => new Request(`https://k.test${sciezka}`, { method });
    expect(czyZadanieStrony(zadanie("/"))).toBe(true);
    expect(czyZadanieStrony(zadanie("/seans/metropolis-2026-11-06/miejsce/F7"))).toBe(true);
    expect(czyZadanieStrony(zadanie("/api/events"))).toBe(false);
    expect(czyZadanieStrony(zadanie("/_next/static/chunks/a.js"))).toBe(false);
    expect(czyZadanieStrony(zadanie("/favicon.ico"))).toBe(false);
    expect(czyZadanieStrony(zadanie("/", "POST"))).toBe(false);
  });

  it("ta sama polityka trafia do żądania (dla Next.js) i na odpowiedź HTML; inne typy bez zmian", () => {
    const { zadanie, polityka } = zadanieZCsp(new Request("https://k.test/"));
    expect(zadanie.headers.get("content-security-policy")).toBe(polityka);
    const html = zCspNaOdpowiedzi(new Response("<p>", { headers: { "content-type": "text/html; charset=utf-8" } }), polityka);
    expect(html.headers.get("content-security-policy")).toBe(polityka);
    const json = zCspNaOdpowiedzi(Response.json({}), polityka);
    expect(json.headers.get("content-security-policy")).toBeNull();
  });
});
