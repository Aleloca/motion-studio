// The guide's table of contents: closed on small screens (open without JS), the section being read marked as current,
// and closed again after a jump on small screens.
const toc = document.querySelector('.toc details');
const wide = matchMedia('(min-width: 1000px)');
const sync = () => { if (toc) toc.open = wide.matches; };
sync();
wide.addEventListener('change', sync);

const links = new Map([...document.querySelectorAll('.toc a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
toc?.addEventListener('click', (e) => { if (e.target.closest('a') && !wide.matches) toc.open = false; });

const seen = new Set();
const io = new IntersectionObserver((entries) => {
  for (const e of entries) { if (e.isIntersecting) seen.add(e.target.id); else seen.delete(e.target.id); }
  const first = [...links.keys()].find((id) => seen.has(id));
  if (!first) return;
  for (const [id, a] of links) { a.classList.toggle('is-current', id === first); if (id === first) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); }
}, { rootMargin: '0px 0px -60% 0px' });
for (const id of links.keys()) { const el = document.getElementById(id); if (el) io.observe(el); }
