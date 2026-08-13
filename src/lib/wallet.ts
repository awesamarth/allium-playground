import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { base, tempo } from "@reown/appkit/networks";

export const projectId =
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ??
  "7077f3033de42968476ef3a7ceac4e01";

export const networks = [tempo, base] as const;

export const wagmiAdapter = new WagmiAdapter({
  networks: [...networks],
  projectId,
  ssr: true,
});

let initialized = false;

export function initializeAppKit() {
  if (initialized) return;

  createAppKit({
    adapters: [wagmiAdapter],
    defaultNetwork: tempo,
    metadata: {
      name: "Allium Playground",
      description: "Ask, approve, and pay for Allium data calls.",
      url: "https://allium-playground.vercel.app",
      icons: ["https://allium-playground.vercel.app/allium-mark.svg"],
    },
    networks: [...networks],
    projectId,
    features: {
      analytics: false,
      email: false,
      socials: false,
    },
    themeMode: "light",
    themeVariables: {
      "--w3m-accent": "#161015",
      "--w3m-border-radius-master": "1px",
      "--w3m-font-family": "var(--font-manrope)",
    },
  });

  initialized = true;
}
