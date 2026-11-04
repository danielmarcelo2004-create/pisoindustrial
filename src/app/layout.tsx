import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SISTEMA } from "@/lib/sistema";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: SISTEMA.nome, template: `%s · ${SISTEMA.sigla}` },
  description: "Gestão financeira, pagamentos e aprovações de obras",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
