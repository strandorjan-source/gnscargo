import './globals.css';

export const metadata = {
  title: 'GNS Cargo Ordre',
  description: 'Ordre- og transportstyring for GNS Cargo AS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
