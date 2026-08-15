import "./globals.css";

export const metadata = {
  title: "Concealment Routing — Dnipro",
  description: "Time-of-day concealment routing for low-altitude drones",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
