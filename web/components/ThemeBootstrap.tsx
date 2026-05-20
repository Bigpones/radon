const SCRIPT = `(function(){try{var k='theme';var s=localStorage.getItem(k);var t=(s==='dark'||s==='light')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('content',t==='dark'?'#0a0f14':'#ffffff');}}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function ThemeBootstrap() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
