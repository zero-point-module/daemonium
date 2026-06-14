import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { SITE_URL, SITE_NAME, SITE_TITLE, SITE_DESCRIPTION } from './site-config';

// The design language uses JetBrains Mono for ENS handles, timers, and counts.
// Loaded here (hoisted, self-hosted, no render-blocking <link>) and wired to
// Tailwind's --font-mono in globals.css, so every `font-mono` use picks it up.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

// Open Graph / Twitter card images, the favicon, the app icon and the apple-touch icon are all
// picked up automatically by Next from the files in app/ (opengraph-image.png, twitter-image.png,
// favicon.ico, icon.png, apple-icon.png) and resolved against metadataBase — so they aren't
// repeated here. (Regenerate them from the idle flame with `node scripts/gen-icons.mjs`.)
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // The browser-tab title is just "Daemonium" on every page (no per-page suffix/template).
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    'Daemonium',
    'Ignis',
    'onchain agent',
    'AI agent',
    'voice agent',
    'crypto wallet',
    'ENS',
    'ERC-8004',
    'Base',
    'Ethereum',
  ],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: 'technology',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Ignis',
  },
  formatDetection: { telephone: false, email: false, address: false },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#050505',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
