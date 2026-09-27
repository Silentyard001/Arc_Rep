/**
 * src/App.tsx
 * Arc Rep — application shell with routing.
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Nav } from './components/Nav.js';
import { WalletLookup } from './components/WalletLookup.js';
import { ProfileShell } from './components/ProfileShell.js';
import { DocsShell } from './components/DocsShell.js';

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-dvh flex flex-col">
        <Nav />
        <main className="flex-1 py-10 px-4 sm:px-6">
          <Routes>
            <Route
              path="/"
              element={
                <div className="flex flex-col items-center justify-center min-h-[calc(100dvh-10rem)]">
                  <WalletLookup />
                </div>
              }
            />
            <Route path="/profile/:address" element={<ProfileShell />} />
            <Route path="/docs" element={<DocsShell />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
