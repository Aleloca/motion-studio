// The final cut's controls: play and pause, seek (with a mark at each scene), play from the start, full screen. The film
// plays once when it comes on screen (motion allowed); under reduced motion it waits on its poster frame for Play. A pause
// is the viewer's and holds; off screen the film pauses and picks up again when it returns.
export const formatTime = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** @param {import('./player.js').CompositionPlayer} player */
export function finalCut(player) {
  const fig = player.figure;
  const q = (s) => fig.querySelector(s);
  const play = q('.player-bar__play'); const seek = q('.player-bar__seek'); const fill = q('.player-bar__fill');
  const now = q('.player-bar__now'); const dur = q('.player-bar__dur'); const chapters = q('.player-bar__chapters');
  let dragging = false;
  let marked = false;

  const paint = (p) => {
    const d = p.duration || 0;
    const t = Math.min(p.time, d || p.time);
    fig.classList.toggle('is-playing', p.playing);
    play.setAttribute('aria-label', p.playing ? 'Pause' : 'Play');
    now.textContent = formatTime(t);
    dur.textContent = d ? formatTime(d) : '--:--';
    const ratio = d ? t / d : 0;
    fill.style.setProperty('--p', String(ratio));
    if (!dragging) seek.value = String(Math.round(ratio * 1000));
    seek.setAttribute('aria-valuetext', `${formatTime(t)} of ${formatTime(d)}`);
    if (!marked && d && p.scenes.length) {
      marked = true;
      for (const s of p.scenes.filter((x) => x.start > 0)) {
        const i = document.createElement('i');
        i.style.left = `${(s.start / d) * 100}%`;
        if (s.name) i.title = s.name;
        chapters.append(i);
      }
    }
    // Played to the end: it stays on its last frame until the viewer plays it again.
    if (p.ended && p.state.intent !== 'pause') p.update({ intent: 'pause' });
  };
  player.onChange(paint);

  play.addEventListener('click', () => {
    player.update({ intent: player.playing ? 'pause' : 'play' });
    paint(player);
  });
  q('.player-bar__replay').addEventListener('click', () => {
    player.update({ intent: 'play' });
    if (!player.seekTo(0)) return;
    if (!player.playing) player.update({});
  });
  seek.addEventListener('input', () => {
    dragging = true;
    const t = (Number(seek.value) / 1000) * (player.duration || 0);
    if (player.seekTo(t)) fill.style.setProperty('--p', String(Number(seek.value) / 1000));
  });
  seek.addEventListener('change', () => { dragging = false; });
  q('.player-bar__full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else fig.requestFullscreen?.().catch(() => {});
  });
}
