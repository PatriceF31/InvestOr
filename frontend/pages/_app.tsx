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

export default function App({ Component, pageProps }: AppProps) {
  const { messages, locale } = pageProps;

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={{ lightMode: goldLight, darkMode: goldDark }} locale={locale ?? "fr"}>
          <NextIntlClientProvider
            locale={locale ?? "fr"}
            messages={messages ?? {}}
            onError={(error) => {
              if (error.code === "ENVIRONMENT_FALLBACK") return;
              console.error(error);
            }}
            getMessageFallback={({ key }) => key}
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
