'use strict';

// Browser playback only: the C engine owns when a cinematic runs. Its
// Asyncify movie call awaits this promise, including an autoplay prompt.
(() => {
  const movieRoot = new URL('movies/', document.currentScript.src);
  const surface = document.getElementById('game-surface');
  const canvas = document.getElementById('canvas');
  const overlay = document.getElementById('movie-overlay');
  const video = document.getElementById('movie-video');
  const message = document.getElementById('movie-message');
  const playButton = document.getElementById('movie-play');
  const skipButton = document.getElementById('movie-skip');
  const fullscreenButton = document.getElementById('movie-fullscreen');
  const history = [];
  let active = null;

  function fitCanvas() {
    surface.style.setProperty('--canvas-aspect', canvas.width / canvas.height);
  }
  new MutationObserver(fitCanvas).observe(canvas, {attributes:true, attributeFilter:['width','height']});
  fitCanvas();

  async function play(name, scale = 1, volume = 1) {
    const base = /^(intro|outro)\.bik$/i.exec(name)?.[1].toLowerCase();
    if (!base || active) {
      window.Module?.printErr?.(`Movie rejected: ${name}`);
      return -1;
    }
    const audioContext = window.AL?.currentCtx?.audioCtx || window.SDL2?.audioContext;
    const resumeGameAudio = audioContext?.state === 'running';
    if (document.pointerLockElement) document.exitPointerLock();
    if (resumeGameAudio) {
      try { await audioContext.suspend(); } catch { /* A shutting-down engine may already have closed it. */ }
    }
    const entry = {name, scale, volume, startedAt:new Date().toISOString(), result:null, reason:null, playedSeconds:0};
    history.push(entry);
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    let settled = false;
    function complete(result, reason) {
      if (settled) return;
      settled = true;
      entry.result = result;
      entry.reason = reason;
      entry.playedSeconds = video.currentTime;
      entry.duration = Number.isFinite(video.duration) ? video.duration : null;
      entry.endedAt = new Date().toISOString();
      finish(result);
    }
    async function attemptPlay() {
      if (settled) return;
      try {
        await video.play();
        if (settled) return;
        playButton.hidden = true;
        message.textContent = `${base === 'intro' ? 'Opening' : 'Ending'} movie · Escape / Space to skip`;
      } catch (error) {
        if (settled) return;
        if (error.name === 'NotAllowedError') {
          playButton.hidden = false;
          message.textContent = 'Your browser needs a click to play the movie with sound.';
          playButton.focus();
        } else {
          window.Module?.printErr?.(`Movie ${name}: ${error.message}`);
          complete(-1, error.name);
        }
      }
    }
    const onEnded = () => complete(0, 'ended');
    const onError = () => {
      const reason = `media-error-${video.error?.code || 'unknown'}`;
      window.Module?.printErr?.(`Movie ${name} unavailable (${reason}). Run convert-movies.mjs to prepare local copies.`);
      complete(-1, reason);
    };
    const onSkip = () => complete(1, 'button');
    const onKey = event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'keydown' && !event.repeat && ['Escape',' ','Enter'].includes(event.key)) {
        if (!playButton.hidden && event.key === 'Enter') attemptPlay();
        else complete(1, `key-${event.key}`);
      }
    };
    active = {name, complete};
    overlay.hidden = false;
    playButton.hidden = true;
    message.textContent = `Loading ${base} movie…`;
    skipButton.focus();
    video.muted = false;
    video.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    playButton.addEventListener('click', attemptPlay);
    skipButton.addEventListener('click', onSkip);
    // Intercept before SDL's window listeners, including key-up. Video keys
    // never become game input; a second movie installs fresh listeners.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    video.src = new URL(`${base}.mp4`, movieRoot).href;
    video.load();
    attemptPlay();
    try {
      return await completion;
    } finally {
      video.pause();
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      playButton.removeEventListener('click', attemptPlay);
      skipButton.removeEventListener('click', onSkip);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      video.removeAttribute('src');
      video.load();
      overlay.hidden = true;
      active = null;
      canvas.focus();
      if (resumeGameAudio && audioContext.state === 'suspended') {
        try { await audioContext.resume(); } catch { /* A future canvas click can resume audio. */ }
      }
    }
  }
  fullscreenButton.addEventListener('click', () => {
    surface.requestFullscreen().catch(error => { message.textContent = `Fullscreen: ${error.message}`; });
  });
  window.OniMovies = {
    play,
    get active() { return active?.name || null; },
    get history() { return history.map(entry => ({...entry})); },
  };
})();
