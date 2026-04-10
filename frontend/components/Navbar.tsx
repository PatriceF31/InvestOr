import Link from "next/link";
import { useRouter } from "next/router";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useTranslations, useLocale } from "next-intl";
import { Sun, Moon, Globe } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { Button } from "@/components/ui/button";
import { useContracts } from "@/hooks/useContracts";

// Liens publics — visibles par tous
const PUBLIC_LINKS = [
  { key: "dashboard", href: "/" },
  { key: "trade",     href: "/trade" },
  { key: "reserve",   href: "/reserve" },
  { key: "history",   href: "/history" },
  { key: "price",     href: "/price" },
];

// Liens admin — visibles uniquement par le owner
const ADMIN_LINKS = [
  { key: "deposit",   href: "/deposit" },
  { key: "admin",     href: "/admin" },
];

export default function Navbar() {
  const t = useTranslations("nav");
  const router = useRouter();
  const { query, asPath } = router;
  const locale = useLocale();
  const toggleLocale = () => {
    const next = locale === "fr" ? "pt" : "fr";
    const currentPath = asPath.replace(/^\/[a-z]{2}(\/|$)/, "/") || "/";
    document.cookie = `NEXT_LOCALE=${next};path=/;max-age=31536000`;
    window.location.href = `/${next}${currentPath}`;
  };
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { gld } = useContracts();

  // Vérifier si l'adresse connectée est le owner du contrat GLD
  const { data: ownerAddress } = useReadContract({
    ...gld,
    functionName: "owner",
  });

  const isOwner = isConnected &&
    address !== undefined &&
    ownerAddress !== undefined &&
    address.toLowerCase() === (ownerAddress as string).toLowerCase();

  const NAV_LINKS = [
    ...PUBLIC_LINKS,
    ...(mounted && isOwner ? ADMIN_LINKS : []),
  ];

  // Initialiser le thème depuis localStorage
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = saved ? saved === "dark" : prefersDark;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
    setMounted(true);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  const isActive = (href: string) => {
    const current = asPath.replace(/^\/[a-z]{2}/, "") || "/";
    return current === href;
  };

  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="text-2xl font-bold text-primary">InvestOr</span>
            <span className="hidden sm:inline text-xs text-muted-foreground border border-border rounded px-1.5 py-0.5">
              Gold Token
            </span>
          </Link>

          {/* Navigation centrale */}
          <div className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map(({ key, href }) => (
              <Link
                key={key}
                href={`/${locale}${href}`}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  isActive(href)
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
              >
                {t(key)}
              </Link>
            ))}
          </div>

          {/* Actions droite */}
          <div className="flex items-center gap-2">
            {/* Switch langue */}
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleLocale}
              className="gap-1.5 text-muted-foreground"
              aria-label="Changer de langue"
            >
              <Globe className="h-4 w-4" />
              <span className="text-xs font-medium uppercase">{locale}</span>
            </Button>

            {/* Switch thème */}
            {mounted && (
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                aria-label="Changer le thème"
              >
                {dark
                  ? <Sun className="h-4 w-4 text-muted-foreground" />
                  : <Moon className="h-4 w-4 text-muted-foreground" />
                }
              </Button>
            )}

            {/* Connect Wallet */}
            <ConnectButton
              showBalance={false}
              chainStatus="icon"
              accountStatus="avatar"
            />
          </div>
        </div>

        {/* Navigation mobile */}
        <div className="md:hidden flex gap-1 pb-3 overflow-x-auto">
          {NAV_LINKS.map(({ key, href }) => (
            <Link
              key={key}
              href={`/${locale}${href}`}
              className={`shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                isActive(href)
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              {t(key)}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
