import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Harness Build Dashboard',
  description: 'Cycle statistics inferred from agent chat transcripts.',
};

const NAV = [
  { href: '/', label: 'Projects' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/upload', label: 'Upload' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header
          className="sticky top-0 z-20 border-b backdrop-blur"
          style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--bg) 88%, transparent)' }}
        >
          <div className="mx-auto flex max-w-[1180px] items-center gap-6 px-4 py-3">
            <Link href="/" className="flex items-baseline gap-2 focusable rounded">
              <span className="text-[15px] font-semibold tracking-tight">Harness Build Dashboard</span>
            </Link>
            <nav className="flex items-center gap-1 text-[13.5px]">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="focusable rounded px-2.5 py-1.5 transition-colors hover:bg-[var(--surface-2)]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-[1180px] px-4 py-7">{children}</main>
        <footer
          className="mx-auto max-w-[1180px] px-4 pb-10 pt-4 text-[12.5px]"
          style={{ color: 'var(--text-faint)' }}
        >
          Figures are derived from uploaded transcripts only. Percentiles use R-7 interpolation;
          correlations are suppressed below n = 8.
        </footer>
      </body>
    </html>
  );
}
