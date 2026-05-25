import type { AppProps } from "next/app";
import { NextIntlClientProvider } from "next-intl";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, lightTheme, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi.config";
import Layout from "@/components/Layout";
import "@rainbow-me/rainbowkit/styles.css";
import "@/styles/globals.css";

const queryClient = new QueryClient();

const goldLight = lightTheme({
  accentColor: "#D4AF37",
  accentColorForeground: "#1a1a1a",
  borderRadius: "medium",
  fontStack: "system",
});

const goldDark = darkTheme({
  accentColor: "#D4AF37",
  accentColorForeground: "#1a1a1a",
  borderRadius: "medium",
  fontStack: "system",
});

// Cache des messages pour la navigation client-side
let cachedMessages: Record<string, any> = {};
let cachedLocale = "fr";

export default function App({ Component, pageProps }: AppProps) {
  // Mettre à jour le cache si de nouveaux messages arrivent
  if (pageProps.messages) {
    cachedMessages = pageProps.messages;
  }
  if (pageProps.locale) {
    cachedLocale = pageProps.locale;
  }
  const messages = cachedMessages;
  const locale   = pageProps.locale ?? cachedLocale;

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={{ lightMode: goldLight, darkMode: goldDark }} locale={locale ?? "fr"}>
          <NextIntlClientProvider
            locale={locale ?? "fr"}
            messages={messages ?? {}}
            onError={(error) => {
              // Ignorer les erreurs de messages manquants — se produit
              // lors de la navigation côté client entre pages SSG
              if (error.code === "ENVIRONMENT_FALLBACK") return;
              if (error.code === "MISSING_MESSAGE") return;
              console.error(error);
            }}
            getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}
          >
            <Layout>
              <Component {...pageProps} />
            </Layout>
          </NextIntlClientProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
