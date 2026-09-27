/**
 * src/components/Nav.tsx
 * Arc Rep top navigation bar.
 */

import { Link, useLocation } from 'react-router-dom';
import { Shield } from 'lucide-react';

export function Nav() {
  const { pathname } = useLocation();

  const linkClass = (path: string) =>
    `text-sm font-medium transition-colors duration-150 ${
      pathname === path || pathname.startsWith(path + '/')
        ? 'text-[--ink]'
        : 'text-[--muted] hover:text-[--ink-2]'
    }`;

  return (
    <header
      className="sticky top-0 z-50 border-b border-[--border]"
      style={{ background: 'var(--surface-strong)', backdropFilter: 'blur(12px)' }}
    >
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        {/* Wordmark */}
        <Link to="/" className="flex items-center gap-2 group">
          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-[--ink] text-white">
            <Shield size={14} strokeWidth={2.5} />
          </span>
          <span
            className="display font-semibold text-[--ink] tracking-tight"
            style={{ letterSpacing: '-0.02em' }}
          >
            Arc Rep
          </span>
        </Link>

        {/* Nav links */}
        <nav className="flex items-center gap-6">
          <Link to="/" className={linkClass('/')}>
            Lookup
          </Link>
          <Link to="/docs" className={linkClass('/docs')}>
            API Docs
          </Link>
        </nav>
      </div>
    </header>
  );
}
