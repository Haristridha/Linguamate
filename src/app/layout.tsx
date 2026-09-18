export const metadata = {
  title: "LinguaMate",
  description: "AI English tutor bot for Indonesian learners",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
