'use strict';

// Resolve beside this script, not the domain root. GitHub project Pages lives
// under /repository/, while the local server lives at /.
const appBase = new URL('.', document.currentScript.src);
const assetURL = filename => new URL(filename, appBase).href;
const canvas = document.getElementById('canvas');
const statusLine = document.getElementById('status');
const logPanel = document.getElementById('log');
const bootButton = document.getElementById('boot');
const scope = document.getElementById('scope');
const progress = document.getElementById('progress');
const lockButton = document.getElementById('lock');
const fullscreenButton = document.getElementById('fullscreen');
const saveButton = document.getElementById('save');
const importButton = document.getElementById('import-save');
const saveFile = document.getElementById('save-file');
let pendingSave;
let manifest = [];
let mounted = false;
let started = false;
let logPoll;
let savePoll;
let persistentSaves = false;
let movieAvailability = {};
let hostingMode = 'local';
const knownLogs = new Map();
window.__oniPort = {
  get status() { return statusLine.textContent; },
  get started() { return started; },
  get mounted() { return mounted; },
  get persistentSaves() { return persistentSaves; },
  get manifest() { return manifest; },
  get hostingMode() { return hostingMode; },
  get diagnostics() { return logPanel.textContent; },
  readFile(filename) { return window.Module.FS.readFile(filename, { encoding: 'utf8' }); },
  snapshot() {
    const engine = window.Module;
    return engine?._oni_browser_snapshot
      ? JSON.parse(engine.UTF8ToString(engine._oni_browser_snapshot())) : null;
  },
  collectEngineLogs,
};

function log(message) {
  if (message === 'engine startup complete, launch the out-of-game UI...') status('Original Oni main menu initialized. Port verification is incomplete.');
  if (message === 'running game...') status('Original Oni mission loaded. Port verification is incomplete.');
  logPanel.textContent += `${String(message)}\n`;
  if (logPanel.textContent.length > 100000) logPanel.textContent = logPanel.textContent.slice(-100000);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function status(message) { statusLine.textContent = message; }
function mib(bytes) { return `${(bytes / 1048576).toFixed(1)} MiB`; }

function selectedFiles() {
  return manifest.filter(file => {
    if (/\.bik$/i.test(file.path)) return false; // Movies stream from converted copies, outside WASM memory.
    if (scope.value === 'all') return true;
    return /^IGMD\//i.test(file.path) || /^level[01]_.*\.(dat|raw|sep)$/i.test(file.path);
  });
}

function refreshDataNote() {
  const files = selectedFiles();
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const moviesReady = movieAvailability.intro && movieAvailability.outro;
  document.getElementById('data-note').textContent = `${files.length} original files · ${mib(bytes)}. The engine uses additional memory. ${moviesReady ? 'Intro/outro playback uses converted movie copies.' : 'Movie copies missing: the host must prepare them using convert-movies.mjs.'}`;
}

async function readJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function inspect() {
  try {
    if (!['http:', 'https:'].includes(location.protocol)) throw new Error('Open this game through an HTTP/HTTPS host, not by double-clicking index.html.');
    const engine = await readJson(assetURL('hosting.json'));
    if (engine.format !== 'oni-host-v1' || !Array.isArray(engine.files)) throw new Error('Invalid hosting manifest. Rebuild the static deployment or update the local server.');
    const paths = new Set();
    for (const file of engine.files) {
      if (typeof file.path !== 'string' || /[\\\u0000]/.test(file.path) ||
          file.path.split('/').some(part => !part || part === '.' || part === '..') ||
          !Number.isSafeInteger(file.size) || file.size < 0 || paths.has(file.path)) {
        throw new Error('Invalid or duplicate original-file entry in hosting.json.');
      }
      paths.add(file.path);
    }
    manifest = engine.files;
    hostingMode = engine.hosting === 'static' ? 'static' : 'local';
    if (engine.defaultScope === 'all') scope.value = 'all';
    movieAvailability = engine.movies || {};
    refreshDataNote();
    log(`Original data inventory: ${manifest.length} files, ${mib(manifest.reduce((sum, file) => sum + file.size, 0))}.`);
    log(`Hosting: ${hostingMode}. Engine files: ${assetURL('engine/')}`);
    if (!engine.engineReady) {
      status('The WebAssembly engine is not built yet. The original game cannot run until Oni.js and Oni.wasm are compiled.');
      log(`Build artifacts: Oni.js ${engine.javascript ? 'present' : 'missing'}, Oni.wasm ${engine.wasm ? 'present' : 'missing'}. Refresh after a successful engine build.`);
      return;
    }
    if (!manifest.some(file => file.path === 'level0_Final.dat') || !manifest.some(file => file.path === 'level1_Final.dat')) {
      throw new Error('The original menu or warehouse DAT archive is missing.');
    }
    status('Compiled engine found. Choose resources, then start the original engine.');
    bootButton.disabled = false;
    importButton.disabled = false;
  } catch (error) {
    status('The original engine is not ready to start.');
    log(error.stack || error.message);
  }
}

function mkdirTree(FS, directory) {
  let current = '';
  for (const part of directory.split('/').filter(Boolean)) {
    current += `/${part}`;
    try { FS.mkdir(current); } catch (error) {
      if (!FS.analyzePath(current).exists) throw error;
    }
  }
}

async function mountOriginalData() {
  const FS = window.Module.FS;
  if (!FS) throw new Error('The generated engine did not export its virtual filesystem.');
  mkdirTree(FS, '/oni/GameDataFolder');
  mkdirTree(FS, '/saves');
  const IDBFS = window.Module.IDBFS || window.IDBFS;
  if (IDBFS) {
    try {
      FS.mount(IDBFS, { autoPersist: true }, '/saves');
      await new Promise((resolve, reject) => FS.syncfs(true, error => error ? reject(error) : resolve()));
      persistentSaves = true;
      log('Restored original engine saves from this browser\'s IndexedDB storage.');
      savePoll = setInterval(() => FS.syncfs(false, error => { if (error) log(`Save persistence: ${error.message || error}`); }), 10000);
      document.getElementById('save-note').textContent = 'Saves persist in this browser using IndexedDB. Download save provides a separate backup. Movies stream separately from converted copies. No saves are uploaded to the host.';
    } catch (error) {
      log(`Persistent save storage unavailable: ${error.message || error}. Saves remain in this tab; download before closing.`);
    }
  } else {
    log('Engine does not export IDBFS. Saves remain in this tab; download before closing.');
  }
  mkdirTree(FS, '/home/web_user/Library/Application Support/OniARM64');
  mkdirTree(FS, '/home/web_user/Library/Logs/OniARM64');
  mkdirTree(FS, '/home/oni/Library/Application Support/OniARM64');
  mkdirTree(FS, '/home/oni/Library/Logs/OniARM64');
  if (pendingSave) {
    const engine = window.Module;
    const schema = JSON.parse(engine.UTF8ToString(engine._oni_browser_save_schema()));
    const header = new DataView(pendingSave.bytes.buffer, pendingSave.bytes.byteOffset, pendingSave.bytes.byteLength);
    if (pendingSave.bytes.length !== schema.size || header.getUint32(0, true) !== schema.version || header.getUint32(4, true) !== schema.swapCode) {
      const error = new Error(`Save is incompatible with this engine: expected ${schema.size} bytes, version ${schema.version}, matching byte-order marker. Existing save was not replaced.`);
      error.code = 'INCOMPATIBLE_SAVE';
      throw error;
    }
    if (FS.analyzePath('/saves/persist.dat').exists) {
      FS.writeFile(`/saves/persist-before-import-${Date.now()}.dat`, FS.readFile('/saves/persist.dat'));
      log('Backed up the existing browser save under /saves before importing.');
    }
    FS.writeFile('/saves/persist.dat', pendingSave.bytes);
    if (persistentSaves) await new Promise((resolve, reject) => FS.syncfs(false, error => error ? reject(error) : resolve()));
    log(`Imported engine save without modifying its bytes: ${pendingSave.name} (${pendingSave.bytes.length} bytes).`);
  }
  FS.chdir('/oni');
  const files = selectedFiles();
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let loaded = 0;
  for (const file of files) {
    status(`Loading original files: ${mib(loaded)} / ${mib(total)} · ${file.path}`);
    const response = await fetch(assetURL(`gamefiles/${file.path.split('/').map(encodeURIComponent).join('/')}`));
    if (!response.ok) throw new Error(`${file.path}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== file.size) throw new Error(`${file.path}: file size differs from inventory (${bytes.byteLength} / ${file.size}).`);
    const destination = `/oni/GameDataFolder/${file.path}`;
    const boundary = destination.lastIndexOf('/');
    mkdirTree(FS, destination.slice(0, boundary));
    FS.createDataFile(destination.slice(0, boundary), destination.slice(boundary + 1), bytes, true, true, true);
    loaded += bytes.byteLength;
    progress.value = total ? loaded / total : 1;
  }
  mounted = true;
  log(`Mounted ${files.length} original data files (${mib(loaded)}) under /oni/GameDataFolder.`);
  log('No replacement characters, maps, combat code, or rendered scenes are supplied by this browser host.');
}

function collectEngineLogs() {
  const FS = window.Module?.FS;
  if (!FS || !mounted) return;
  const filenames = ['/oni/startup.txt', '/oni/debugger.txt', '/oni/OniError.txt', '/home/web_user/Library/Logs/OniARM64/startup.txt', '/home/oni/Library/Logs/OniARM64/startup.txt'];
  for (const filename of filenames) {
    try {
      const text = FS.readFile(filename, { encoding: 'utf8' });
      const previous = knownLogs.get(filename) || '';
      if (text !== previous) {
        log(`[${filename}]\n${text.startsWith(previous) ? text.slice(previous.length) : text}`);
        knownLogs.set(filename, text);
      }
    } catch { /* Engine log files may not exist before initialization. */ }
  }
}

async function engineReady() {
  try {
    await mountOriginalData();
    status('Starting original Oni C engine. Menu and gameplay compatibility are being tested.');
    log('Calling the compiled original engine main entry point.');
    logPoll = setInterval(collectEngineLogs, 750);
    started = true;
    lockButton.disabled = false;
    fullscreenButton.disabled = false;
    saveButton.disabled = false;
    canvas.focus();
    document.getElementById('canvas-note').textContent = 'Original engine output. A blank canvas or an error is a port failure; see diagnostics below.';
    window.Module.callMain([]);
    collectEngineLogs();
  } catch (error) {
    status(error.code === 'INCOMPATIBLE_SAVE' ? 'Selected save was rejected without replacing the existing save. Reload to select a compatible save.' : 'Original engine initialization failed. The port is not playable yet.');
    log(error.stack || error.message);
    collectEngineLogs();
  }
}

bootButton.addEventListener('click', () => {
  bootButton.disabled = true;
  importButton.disabled = true;
  scope.disabled = true;
  status('Loading the compiled original engine…');
  window.Module = {
    canvas,
    oniPlayMovie: (name, scale, volume) => window.OniMovies.play(name, scale, volume),
    noInitialRun: true,
    arguments: [],
    locateFile: filename => assetURL(`engine/${filename}`),
    print: log,
    printErr: log,
    setStatus: message => { if (!started && message) status(`Engine: ${message}`); },
    onRuntimeInitialized: engineReady,
    onAbort: reason => {
      status('Original engine aborted. The port is not playable in this state.');
      log(`Engine abort: ${reason}`);
      collectEngineLogs();
      if (logPoll) clearInterval(logPoll);
    },
  };
  const script = document.createElement('script');
  script.src = assetURL('engine/Oni.js');
  script.onerror = () => {
    status('The compiled engine JavaScript could not load.');
    log(`Failed to load ${script.src}.`);
  };
  document.head.appendChild(script);
});

scope.addEventListener('change', refreshDataNote);
importButton.addEventListener('click', () => saveFile.click());
saveFile.addEventListener('change', async () => {
  pendingSave = undefined;
  const file = saveFile.files[0];
  if (!file) return;
  if (file.size < 8 || file.size > 2097152) {
    document.getElementById('import-note').textContent = 'Invalid save size. Select an original engine persist.dat file.';
    saveFile.value = '';
    return;
  }
  pendingSave = {name:file.name, bytes:new Uint8Array(await file.arrayBuffer())};
  document.getElementById('import-note').textContent = `Selected ${file.name} (${file.size} bytes). The engine format is checked before import; an existing browser save is backed up on start.`;
});
// SDL listens for keyboard input on the window and prevents its default action.
// Keep launcher controls usable with Enter and arrows when they own focus.
// Key-up still reaches SDL so moving focus cannot leave a game key held down.
window.addEventListener('keydown', event => {
  if (window.OniMovies?.active) return; // Movie handler owns its keys while the engine is suspended.
  if (event.target instanceof HTMLElement && event.target !== canvas) event.stopImmediatePropagation();
}, true);
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('click', () => { canvas.focus(); resumeAudio().catch(error=>log(`Audio: ${error.message}`)); });
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  status('The browser lost the original engine graphics context. Reload to restart.');
  log('WebGL context lost.');
});

async function resumeAudio() {
  const context = window.AL?.currentCtx?.audioCtx || window.SDL2?.audioContext;
  if (context?.state === 'suspended') await context.resume();
}

lockButton.addEventListener('click', async () => {
  try { await resumeAudio(); canvas.focus(); await canvas.requestPointerLock(); }
  catch (error) { log(`Mouse capture: ${error.message}`); }
});
fullscreenButton.addEventListener('click', async () => {
  try { await resumeAudio(); await document.getElementById('game-surface').requestFullscreen(); canvas.focus(); }
  catch (error) { log(`Fullscreen: ${error.message}`); }
});

saveButton.addEventListener('click', async () => {
  const FS = window.Module?.FS;
  if (persistentSaves) await new Promise(resolve => FS.syncfs(false, error => { if (error) log(`Save persistence: ${error.message || error}`); resolve(); }));
  const paths = ['/saves/persist.dat', '/oni/persist.dat', '/home/web_user/Library/Application Support/OniARM64/persist.dat', '/home/oni/Library/Application Support/OniARM64/persist.dat'];
  for (const filename of paths) {
    try {
      const bytes = FS.readFile(filename);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'persist.dat';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      log(`Downloaded original engine save: ${filename} (${bytes.byteLength} bytes).`);
      return;
    } catch { /* Try the next engine save location. */ }
  }
  log('No original engine save exists yet.');
});

window.addEventListener('error', event => log(`Browser error: ${event.message}`));
window.addEventListener('unhandledrejection', event => log(`Browser promise error: ${event.reason?.stack || event.reason}`));
inspect();
