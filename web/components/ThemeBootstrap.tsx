// Pre-paint theme bootstrap. Runs synchronously in <head> before React
// hydrates so the first paint already reflects the user's saved theme
// (no flash of dark when the user has light selected). ONLY mutates
// `data-theme` on <html>; the <meta name="theme-color"> tags are owned
// by Next.js's viewport metadata API and must not be touched here, or
// hydration will throw React #418 when the script's mutation races the
// reconciler's view of the head element.
//
// app/layout.tsx adds `suppressHydrationWarning` on <html> so the
// `data-theme` attribute difference between SSR (absent) and the
// post-script DOM (set) is silenced.
const SCRIPT = `(function(){try{var k='theme';var s=localStorage.getItem(k);var t=(s==='dark'||s==='light')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function ThemeBootstrap() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
