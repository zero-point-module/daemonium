import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Daemonium · Ignis',
  description:
    'Summon Ignis — a living flame companion that speaks and acts onchain.',
  applicationName: 'Daemonium',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Ignis',
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
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
