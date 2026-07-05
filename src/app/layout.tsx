import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BTC Option Board",
  description: "Server-cached OKX BTC options dashboard.",
  icons: {
    icon: "/icon.svg"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
