import type { AppProps } from "next/app";
import { NextIntlClientProvider } from "next-intl";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi.config";
import "@rainbow-me/rainbowkit/styles.css";
import "@/styles/globals.css";

const queryClient = new QueryClient();

export default function App({ Component, pageProps }: AppProps) {
  const { messages, locale } = pageProps;

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={lightTheme({
            accentColor: "#D4AF37",
            accentColorForeground: "#1a1a1a",
            borderRadius: "medium",
            fontStack: "system",
          })}
        >
          <NextIntlClientProvider
            locale={locale ?? "fr"}
            messages={messages ?? {}}
            onError={(error) => {
              // Silence ENVIRONMENT_FALLBACK — messages fournis via pageProps
              if (error.code === "ENVIRONMENT_FALLBACK") return;
              console.error(error);
            }}
            getMessageFallback={({ key }) => key}
          >
            <Component {...pageProps} />
          </NextIntlClientProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
