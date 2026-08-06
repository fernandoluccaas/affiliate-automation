import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Affiliate Automation",
  description: "Console administrativo de ofertas afiliadas",
};

const themeScript = `(()=>{try{const value=localStorage.getItem("affiliate-theme");if(value==="light"||value==="dark")document.documentElement.dataset.theme=value;else document.documentElement.removeAttribute("data-theme")}catch{}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
