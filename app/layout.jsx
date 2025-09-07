import "./globals.css";

export const metadata = {
  title: "TubeDrop Display — MVP",
  description: "Single-tube 2D rendering → 1D droplet schedule (Next.js + Canvas)",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
