import { parseLyrics } from './lyrics.js';

const form = document.querySelector('#route-form');
const originInput = document.querySelector('#origin');
const destinationInput = document.querySelector('#destination');
const modeSelect = document.querySelector('#mode');
const generateButton = document.querySelector('#generate-button');
const generateButtonLabel = generateButton.querySelector('span');
const defaultGenerateButtonLabel = generateButtonLabel.textContent;
const formError = document.querySelector('#form-error');
const appStatus = document.querySelector('#app-status');
const introCopy = document.querySelector('#intro-copy');
const songTitle = document.querySelector('#song-title');
const songArtist = document.querySelector('#song-artist');
const songAlbum = document.querySelector('#song-album');
const songTime = document.querySelector('#song-time');
const playPause = document.querySelector('#play-pause');
const audioPlayer = document.querySelector('#audio-player');
const songSeek = document.querySelector('#song-seek');
const lyricsList = document.querySelector('#lyrics-list');
const lyricStatus = document.querySelector('#lyric-status');
const waveform = document.querySelector('#waveform');
const routeProgressTrack = document.querySelector('#route-progress-track');
const routeProgressFill = document.querySelector('#route-progress-fill');
const routeProgressValue = document.querySelector('#route-progress-value');
const modeCombobox = createModeCombobox();
let generateProgress = 0;
const generateStageCounts = new Map();

let playlist = [
  { title: 'Midnight City', artist: 'M83', duration_sec: 260 },
  { title: 'Ambient Night', artist: 'Soundtrack Collection', duration_sec: 248 },
];
let currentSongIndex = 0;
let timedLyrics = [];
let activeLyricIndex = -1;
let loadSequence = 0;
let currentLoadPromise = null;
let routeDurationSeconds = playlist.reduce((total, song) => total + (Number(song.duration_sec) || 0), 0);
const originCombobox = createAddressCombobox(originInput);
const destinationCombobox = createAddressCombobox(destinationInput);

buildWaveform();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = {
    origin: originInput.value.trim(),
    destination: destinationInput.value.trim(),
    originLocation: originCombobox.selected?.location,
    destinationLocation: destinationCombobox.selected?.location,
    mode: modeSelect.value,
  };

  const validationMessage = validateRoute(input, originCombobox.selected, destinationCombobox.selected);
  if (validationMessage) {
    const invalidField = input.origin.length < 2 || !originCombobox.selected || input.origin.toLocaleLowerCase() === input.destination.toLocaleLowerCase()
      ? originInput
      : destinationInput;
    showError(validationMessage, invalidField);
    invalidField.focus({ preventScroll: true });
    return;
  }

  clearError();
  setBusy(true);

  try {
    const response = await fetch('/api/agent/mixtape/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `生成失败（${response.status}）`);
    }
    if (!response.body) throw new Error('服务器未返回可读取的数据流。');

    const result = await consumeSse(response.body);
    if (!result) throw new Error('生成已结束，但没有收到混音带结果。');

    applyResult(result);
    showScreen('intro');
    appStatus.textContent = 'Sound-Map 已生成，已展示导语。';
  } catch (error) {
    showScreen('route');
    showError(error.message || '生成 Sound-Map 时发生错误，请重试。');
    appStatus.textContent = '生成失败，请检查输入后重试。';
  } finally {
    setBusy(false);
  }
});

document.querySelectorAll('[data-go]').forEach((control) => {
  control.addEventListener('click', () => {
    if (control.dataset.go === 'player') {
      enterPlayerAndPlay();
      return;
    }
    showScreen(control.dataset.go);
  });
});

enableIntroSwipe();
lockPlayerPageScroll();

document.querySelector('#previous-song').addEventListener('click', () => changeSong(-1));
document.querySelector('#next-song').addEventListener('click', () => changeSong(1));
playPause.addEventListener('click', togglePlayback);
songSeek.addEventListener('input', seekSong);
audioPlayer.addEventListener('timeupdate', updatePlaybackProgress);
audioPlayer.addEventListener('durationchange', updatePlaybackProgress);
audioPlayer.addEventListener('play', () => setPlaybackState(true));
audioPlayer.addEventListener('pause', () => setPlaybackState(false));
audioPlayer.addEventListener('ended', () => changeSong(1, true));
audioPlayer.addEventListener('error', () => {
  if (audioPlayer.currentSrc) showPlaybackError('音频加载失败，请切换歌曲或稍后重试。');
});

function validateRoute(input, selectedOrigin, selectedDestination) {
  if (input.origin.length < 2) return '请输入至少 2 个字的出发地。';
  if (input.destination.length < 2) return '请输入至少 2 个字的目的地。';
  if (!selectedOrigin) return '请从下拉建议中选择准确的出发地。';
  if (!selectedDestination) return '请从下拉建议中选择准确的目的地。';
  if (input.origin.toLocaleLowerCase() === input.destination.toLocaleLowerCase()) return '出发地和目的地不能相同。';
  return '';
}

function createAddressCombobox(input) {
  const root = input.closest('.address-combobox');
  const listbox = root.querySelector('[role="listbox"]');
  const clearButton = root.querySelector('.address-clear');
  listbox.classList.add('address-listbox--floating');
  document.body.append(listbox);
  let selected = null;
  let suggestions = [];
  let highlightedIndex = -1;
  let requestController = null;
  let timer = null;
  let composing = false;
  let sessionToken = createPlacesSessionToken();

  const api = { get selected() { return selected; }, close: closeListbox };

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; scheduleSearch(); });
  input.addEventListener('input', () => {
    selected = null;
    clearButton.hidden = !input.value;
    if (!composing) scheduleSearch();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || !suggestions.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      highlightedIndex = (highlightedIndex + direction + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (event.key === 'Enter' && highlightedIndex >= 0) {
      event.preventDefault();
      commitSuggestion(suggestions[highlightedIndex]);
    } else if (event.key === 'Escape') {
      closeListbox();
    }
  });
  input.addEventListener('blur', () => setTimeout(closeListbox, 120));
  clearButton.addEventListener('click', () => {
    requestController?.abort();
    clearTimeout(timer);
    input.value = '';
    selected = null;
    clearButton.hidden = true;
    sessionToken = createPlacesSessionToken();
    closeListbox();
    input.focus();
  });

  function scheduleSearch() {
    clearTimeout(timer);
    requestController?.abort();
    selected = null;
    const query = input.value.trim();
    if (query.length < 2) return closeListbox();
    timer = setTimeout(() => search(query), 300);
  }

  async function search(query) {
    requestController = new AbortController();
    showState('正在检索地址…');
    try {
      const params = new URLSearchParams({ q: query, sessionToken });
      const response = await fetch(`/api/places/autocomplete?${params}`, { signal: requestController.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '地址检索失败。');
      if (input.value.trim() !== query) return;
      suggestions = data.suggestions ?? [];
      highlightedIndex = suggestions.length ? 0 : -1;
      if (!suggestions.length) showState('没有匹配地址，请输入更完整的地点。');
      else renderSuggestions();
    } catch (error) {
      if (error.name !== 'AbortError') showState(error.message || '地址检索失败，请重试。');
    }
  }

  function renderSuggestions() {
    listbox.replaceChildren(...suggestions.map((item, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = `address-option${index === highlightedIndex ? ' is-highlighted' : ''}`;
      option.id = `${input.id}-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === highlightedIndex));
      option.innerHTML = `<strong></strong><small></small>`;
      option.querySelector('strong').textContent = item.primaryText;
      option.querySelector('small').textContent = item.secondaryText;
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => commitSuggestion(item));
      option.addEventListener('pointerenter', () => {
        highlightedIndex = index;
        listbox.querySelectorAll('.address-option').forEach((node, optionIndex) => {
          const active = optionIndex === highlightedIndex;
          node.classList.toggle('is-highlighted', active);
          node.setAttribute('aria-selected', String(active));
        });
        input.setAttribute('aria-activedescendant', option.id);
      });
      return option;
    }));
    openListbox();
    input.setAttribute('aria-activedescendant', `${input.id}-option-${highlightedIndex}`);
    listbox.querySelector('.is-highlighted')?.scrollIntoView({ block: 'nearest' });
  }

  async function commitSuggestion(item) {
    showState('正在确认地点…');
    try {
      const params = new URLSearchParams({ placeId: item.placeId, sessionToken });
      const response = await fetch(`/api/places/details?${params}`);
      const place = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(place.error || '无法确认该地点。');
      selected = place;
      input.value = place.address || item.label;
      clearButton.hidden = false;
      sessionToken = createPlacesSessionToken();
      closeListbox();
      clearError();
    } catch (error) { showState(error.message || '无法确认该地点，请重试。'); }
  }

  function showState(message) {
    suggestions = [];
    highlightedIndex = -1;
    const state = document.createElement('div');
    state.className = 'address-state';
    state.textContent = message;
    listbox.replaceChildren(state);
    openListbox();
  }

  function positionListbox() {
    if (listbox.hidden) return;
    const field = input.closest('.route-field');
    const rect = field.getBoundingClientRect();
    const viewport = window.visualViewport;
    const visibleTop = viewport?.offsetTop ?? 0;
    const visibleBottom = visibleTop + (viewport?.height ?? window.innerHeight);
    const width = Math.min(rect.width, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const maxHeight = Math.max(80, Math.min(238, visibleBottom - visibleTop - 16));
    const desiredHeight = Math.min(listbox.scrollHeight, maxHeight);
    let top = rect.bottom + 6;
    let availableBelow = visibleBottom - top - 8;
    let availableHeight = Math.min(maxHeight, availableBelow);
    const modeRect = document.querySelector('#mode-trigger')?.getBoundingClientRect();
    const overlapsMode = modeRect && top < modeRect.bottom && top + desiredHeight > modeRect.top;
    if (overlapsMode) {
      const availableAbove = rect.top - visibleTop - 14;
      if (availableAbove >= 54) {
        availableHeight = Math.min(desiredHeight, availableAbove);
        top = rect.top - availableHeight - 6;
      } else {
        // Keep the transport control tappable even when the keyboard leaves little room above the field.
        availableHeight = Math.max(54, Math.min(desiredHeight, modeRect.top - top - 8));
      }
      availableBelow = visibleBottom - top - 8;
    }
    if (availableBelow < desiredHeight && rect.top - visibleTop > desiredHeight + 6) {
      top = rect.top - desiredHeight - 6;
      availableBelow = visibleBottom - top - 8;
      availableHeight = Math.min(desiredHeight, availableBelow);
    }

    listbox.style.left = `${left}px`;
    listbox.style.top = `${Math.max(visibleTop + 8, top)}px`;
    listbox.style.width = `${width}px`;
    listbox.style.maxHeight = `${Math.max(54, Math.min(maxHeight, availableHeight, availableBelow))}px`;
  }

  window.addEventListener('scroll', positionListbox, { capture: true, passive: true });
  window.addEventListener('resize', positionListbox, { passive: true });
  window.visualViewport?.addEventListener('scroll', positionListbox, { passive: true });
  window.visualViewport?.addEventListener('resize', positionListbox, { passive: true });

  function openListbox() {
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    positionListbox();
  }
  function closeListbox() {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  return api;
}

function createPlacesSessionToken() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();

  // randomUUID is unavailable in some browsers on plain HTTP LAN origins.
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else bytes.forEach((_, index) => { bytes[index] = Math.floor(Math.random() * 256); });
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createModeCombobox() {
  const trigger = document.querySelector('#mode-trigger');
  const listbox = document.querySelector('#mode-listbox');
  listbox.classList.add('address-listbox--floating');
  document.body.append(listbox);
  const options = [...listbox.querySelectorAll('.mode-option')];
  const labels = { walking: '步行', driving: '驾车', bicycling: '骑行' };
  let highlightedIndex = options.findIndex((option) => option.dataset.value === modeSelect.value);

  trigger.addEventListener('click', () => trigger.getAttribute('aria-expanded') === 'true' ? close() : open());
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (trigger.getAttribute('aria-expanded') !== 'true') open();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      highlightedIndex = (highlightedIndex + direction + options.length) % options.length;
      updateHighlight();
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (trigger.getAttribute('aria-expanded') === 'true') {
        event.preventDefault();
        select(options[highlightedIndex].dataset.value);
      }
    } else if (event.key === 'Escape') {
      close();
    }
  });
  options.forEach((option, index) => {
    option.addEventListener('pointerenter', () => { highlightedIndex = index; updateHighlight(); });
    option.addEventListener('click', () => select(option.dataset.value));
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.mode-combobox, #mode-listbox')) close();
  });

  window.addEventListener('scroll', positionListbox, { capture: true, passive: true });
  window.addEventListener('resize', positionListbox, { passive: true });
  window.visualViewport?.addEventListener('scroll', positionListbox, { passive: true });
  window.visualViewport?.addEventListener('resize', positionListbox, { passive: true });

  function positionListbox() {
    if (listbox.hidden) return;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const visibleTop = viewport?.offsetTop ?? 0;
    const visibleBottom = visibleTop + (viewport?.height ?? window.innerHeight);
    const width = Math.min(rect.width, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const desiredHeight = Math.min(listbox.scrollHeight, visibleBottom - visibleTop - 16);
    let top = rect.bottom + 6;
    let availableBelow = visibleBottom - top - 8;
    if (availableBelow < desiredHeight && rect.top - visibleTop > desiredHeight + 6) {
      top = rect.top - desiredHeight - 6;
      availableBelow = visibleBottom - top - 8;
    }
    listbox.style.left = `${left}px`;
    listbox.style.top = `${Math.max(visibleTop + 8, top)}px`;
    listbox.style.width = `${width}px`;
    listbox.style.maxHeight = `${Math.max(80, Math.min(desiredHeight, availableBelow))}px`;
  }

  function open() {
    originCombobox?.close();
    destinationCombobox?.close();
    listbox.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    highlightedIndex = options.findIndex((option) => option.dataset.value === modeSelect.value);
    updateHighlight();
    positionListbox();
  }
  function close() {
    listbox.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  function select(value) {
    modeSelect.value = value;
    trigger.querySelector('.mode-value').textContent = labels[value];
    trigger.setAttribute('aria-label', `交通方式，当前为${labels[value]}`);
    options.forEach((option) => option.setAttribute('aria-selected', String(option.dataset.value === value)));
    close();
    trigger.focus();
  }
  function updateHighlight() {
    options.forEach((option, index) => option.classList.toggle('is-highlighted', index === highlightedIndex));
  }
  return { trigger, close };
}

async function consumeSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (!event) continue;
      if (event.type === 'status') {
        const labels = {
          '\u611f\u77e5': '\u6b63\u5728\u8bfb\u53d6\u8def\u7ebf\u2026',
          '\u89c4\u5212': '\u6b63\u5728\u89c4\u5212\u97f3\u4e50\u2026',
          '\u5224\u65ad': '\u6b63\u5728\u6311\u9009\u6b4c\u66f2\u2026',
          '\u53cd\u601d': '\u6b63\u5728\u5b8c\u5584\u6b4c\u5355\u2026',
        };
        generateButtonLabel.textContent = labels[event.data.stage] || '\u6b63\u5728\u751f\u6210 Sound-Map\u2026';
        advanceGenerateProgress(event.data.stage);
      }
      if (event.type === 'status') appStatus.textContent = '正在生成 Sound-Map。';
      if (event.type === 'result') finalResult = event.data;
      if (event.type === 'error') throw new Error(event.data.error || '生成 Sound-Map 时发生错误。');
    }
    if (done) break;
  }
  return finalResult;
}

function parseSseBlock(block) {
  let type = 'message';
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  try { return { type, data: JSON.parse(dataLines.join('\n')) }; }
  catch { return null; }
}

function applyResult(result) {
  const poem = result.route_poem;
  if (Array.isArray(poem?.ja) && Array.isArray(poem?.zh) && poem.ja.length === 3 && poem.zh.length === 3) {
    renderBilingualPoem(poem);
  } else {
    introCopy.classList.add('is-legacy');
    introCopy.textContent = formatIntroduction(result.introduction || result.announcement || '为这段旅程选好了音乐。');
  }
  fitIntroduction();
  if (Array.isArray(result.playlist) && result.playlist.length) playlist = result.playlist;
  const playlistDuration = playlist.reduce((total, song) => total + (Number(song.duration_sec) || 0), 0);
  routeDurationSeconds = Number(result.route_duration_sec) || playlistDuration;
  currentSongIndex = 0;
  updateRouteProgress();
  loadCurrentSong();
}

function renderBilingualPoem(poem) {
  introCopy.classList.remove('is-legacy');
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 3; index += 1) {
    const pair = document.createElement('div');
    pair.className = 'poem-line-pair';
    for (const [language, value] of [
      ['ja', poem.ja[index]],
      ['zh-CN', poem.zh[index]],
    ]) {
      const line = document.createElement('p');
      line.className = language === 'ja' ? 'poem-ja' : 'poem-zh';
      line.lang = language;
      const text = document.createElement('span');
      text.className = 'poem-text';
      text.textContent = value;
      line.append(text);
      pair.append(line);
    }
    fragment.append(pair);
  }
  introCopy.replaceChildren(fragment);
}

function formatIntroduction(text) {
  return text
    .replace(/。(?=.)/g, '。\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fitIntroduction() {
  const card = introCopy.closest('.intro-card');
  const poemText = [...introCopy.querySelectorAll('.poem-text')].map((line) => line.textContent).join('');
  const characterCount = [...(poemText || introCopy.textContent)].length;
  card.classList.toggle('is-long', characterCount > 70);
  card.classList.toggle('is-very-long', characterCount > 120);
  card.classList.remove('is-scrollable');

  requestAnimationFrame(() => {
    const availableHeight = card.clientHeight - introCopy.offsetTop - 36;
    if (introCopy.scrollHeight > availableHeight) card.classList.add('is-very-long');
    requestAnimationFrame(() => {
      if (introCopy.scrollHeight > availableHeight) card.classList.add('is-scrollable');
    });
  });
}

function changeSong(direction, forceAutoplay = false) {
  if (!playlist.length) return;
  const autoplay = forceAutoplay || !audioPlayer.paused;
  currentSongIndex = (currentSongIndex + direction + playlist.length) % playlist.length;
  loadCurrentSong({ autoplay });
}

function renderSongMetadata() {
  const song = playlist[currentSongIndex] || playlist[0];
  songTitle.textContent = song.title || '未命名曲目';
  songArtist.textContent = song.artist || '未知艺人';
  songAlbum.textContent = song.album || 'Sound-Map Mix';
  const duration = Number(song.duration_sec) || 260;
  songTime.textContent = `00:00 / ${formatTime(duration)}`;
  songSeek.value = '0';
  updateWaveform(0);
  updateRouteProgress();
}

function formatTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(safeSeconds % 60)).padStart(2, '0')}`;
}

async function loadCurrentSong({ autoplay = false } = {}) {
  const song = playlist[currentSongIndex];
  const sequence = ++loadSequence;
  audioPlayer.pause();
  audioPlayer.removeAttribute('src');
  audioPlayer.load();
  renderSongMetadata();
  renderLyrics([], '正在加载歌词…');

  if (!song?.song_id) {
    renderLyrics([], '生成歌单后即可播放');
    return;
  }

  setPlayerLoading(true);
  currentLoadPromise = (async () => {
    try {
      const response = await fetch(`/api/music/playback/${encodeURIComponent(song.song_id)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '无法加载这首歌。');
      if (sequence !== loadSequence) return;

      timedLyrics = parseLyrics(data.lyric, data.translatedLyric);
      renderLyrics(timedLyrics, timedLyrics.length ? '-- 实时同步歌词 --' : '这首歌暂无滚动歌词');
      audioPlayer.src = data.audioUrl;
      audioPlayer.load();
      if (autoplay) await playAudio();
    } catch (error) {
      if (sequence === loadSequence) showPlaybackError(error.message || '无法加载这首歌。');
    } finally {
      if (sequence === loadSequence) setPlayerLoading(false);
    }
  })();
  await currentLoadPromise;
}

async function togglePlayback() {
  if (!audioPlayer.paused) {
    audioPlayer.pause();
    return;
  }
  if (currentLoadPromise) await currentLoadPromise;
  if (!audioPlayer.currentSrc) await loadCurrentSong();
  if (audioPlayer.currentSrc) await playAudio();
}

async function playAudio() {
  try {
    await audioPlayer.play();
  } catch (error) {
    const message = error.name === 'NotAllowedError'
      ? '浏览器阻止了自动播放，请再次点击播放。'
      : '播放失败，请切换歌曲或稍后重试。';
    showPlaybackError(message);
  }
}

function setPlaybackState(playing) {
  playPause.setAttribute('aria-pressed', String(playing));
  playPause.setAttribute('aria-label', playing ? '暂停' : '播放');
  playPause.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>';
  appStatus.textContent = playing ? `正在播放 ${songTitle.textContent}。` : '播放已暂停。';
}

function setPlayerLoading(loading) {
  playPause.disabled = loading;
  playPause.setAttribute('aria-busy', String(loading));
}

function seekSong() {
  if (!Number.isFinite(audioPlayer.duration)) return;
  audioPlayer.currentTime = (Number(songSeek.value) / 1000) * audioPlayer.duration;
  updatePlaybackProgress();
}

function updatePlaybackProgress() {
  const duration = Number.isFinite(audioPlayer.duration)
    ? audioPlayer.duration
    : Number(playlist[currentSongIndex]?.duration_sec) || 0;
  const current = Number.isFinite(audioPlayer.currentTime) ? audioPlayer.currentTime : 0;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  songTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  songSeek.value = String(Math.round(progress * 1000));
  songSeek.setAttribute('aria-valuetext', `${formatTime(current)}，共 ${formatTime(duration)}`);
  updateWaveform(progress);
  updateActiveLyric(current);
  updateRouteProgress();
}

function updateRouteProgress() {
  const completedSeconds = playlist.slice(0, currentSongIndex)
    .reduce((total, song) => total + (Number(song.duration_sec) || 0), 0);
  const currentSeconds = Number.isFinite(audioPlayer.currentTime) ? audioPlayer.currentTime : 0;
  const progress = routeDurationSeconds > 0
    ? Math.min(1, Math.max(0, (completedSeconds + currentSeconds) / routeDurationSeconds))
    : 0;
  const percent = Math.round(progress * 100);
  routeProgressFill.style.width = `${progress * 100}%`;
  routeProgressValue.textContent = `${percent}%`;
  routeProgressTrack.setAttribute('aria-valuenow', String(percent));
  routeProgressTrack.setAttribute('aria-valuetext', `行程进度 ${percent}%`);
}

function updateWaveform(progress) {
  const bars = [...waveform.children];
  bars.forEach((bar, index) => bar.classList.toggle('is-played', (index + 1) / bars.length <= progress));
}

function renderLyrics(lines, status) {
  timedLyrics = lines;
  activeLyricIndex = -1;
  lyricStatus.textContent = status;
  const items = lines.length ? lines : [{ text: status, translation: '' }];
  lyricsList.replaceChildren(...items.map((line, index) => {
    const item = document.createElement('li');
    item.dataset.index = String(index);
    if (!lines.length) item.classList.add('is-active');
    item.textContent = line.text;
    if (line.translation) {
      const translation = document.createElement('small');
      translation.textContent = line.translation;
      item.append(translation);
    }
    return item;
  }));
  lyricsList.scrollTop = 0;
}

function updateActiveLyric(currentTime) {
  if (!timedLyrics.length) return;
  let nextIndex = -1;
  for (let index = 0; index < timedLyrics.length; index += 1) {
    if (timedLyrics[index].time <= currentTime + .05) nextIndex = index;
    else break;
  }
  if (nextIndex === activeLyricIndex) return;
  activeLyricIndex = nextIndex;
  lyricsList.querySelectorAll('li').forEach((item, index) => item.classList.toggle('is-active', index === nextIndex));
  const active = lyricsList.children[nextIndex];
  if (!active) return;
  // offsetTop is relative to the element's offsetParent, which can differ
  // between desktop and mobile layouts. Measure both elements in the same
  // viewport coordinate space so the active line lands at the list's center.
  const listRect = lyricsList.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  const scrollportTop = listRect.top + lyricsList.clientTop;
  const scrollportCenter = scrollportTop + lyricsList.clientHeight / 2;
  const activeCenter = activeRect.top + activeRect.height / 2;
  lyricsList.scrollTo({
    top: lyricsList.scrollTop + activeCenter - scrollportCenter,
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

function showPlaybackError(message) {
  audioPlayer.pause();
  renderLyrics([], message);
  setPlaybackState(false);
  appStatus.textContent = message;
}

let screenTransitionId = 0;
let screenTransitionAnimations = [];

function showScreen(name) {
  const screens = [...document.querySelectorAll('.app-screen')];
  const target = screens.find((screen) => screen.dataset.screen === name);
  if (!target) return;
  const outgoing = screens.find((screen) => screen.classList.contains('is-active'));
  if (outgoing === target) return;

  const transitionId = ++screenTransitionId;
  screenTransitionAnimations.forEach((animation) => animation.cancel());
  screenTransitionAnimations = [];

  screens.forEach((screen) => {
    const isTarget = screen === target;
    screen.classList.toggle('is-active', isTarget);
    screen.classList.toggle('is-exiting', !isTarget && screen === outgoing);
    screen.inert = !isTarget;
    screen.setAttribute('aria-hidden', String(!isTarget));
  });
  const mobile = window.matchMedia('(max-width: 1099px)').matches;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!outgoing || !mobile || reducedMotion || typeof target.animate !== 'function') {
    outgoing?.classList.remove('is-exiting');
    return;
  }

  let outgoingFrames;
  let incomingFrames;
  let duration;
  let easing;

  if (outgoing.dataset.screen === 'route' && name === 'intro') {
    duration = 680;
    easing = 'cubic-bezier(.22,.74,.18,1)';
    outgoingFrames = [
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      { opacity: 0.12, transform: 'translate3d(-1.2%, -0.8%, 0)' },
    ];
    incomingFrames = [
      { opacity: 0, transform: 'translate3d(0, 24px, 0)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ];
  } else if (outgoing.dataset.screen === 'intro' && name === 'player') {
    duration = 620;
    easing = 'cubic-bezier(.16,1,.3,1)';
    outgoingFrames = [
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      { opacity: 0.16, transform: 'translate3d(0, -8%, 0)' },
    ];
    incomingFrames = [
      { opacity: 0, transform: 'translate3d(0, 12%, 0)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ];
  } else {
    duration = 480;
    easing = 'cubic-bezier(.22,.74,.18,1)';
    outgoingFrames = [
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      { opacity: 0, transform: 'translate3d(0, -12px, 0)' },
    ];
    incomingFrames = [
      { opacity: 0, transform: 'translate3d(0, 16px, 0)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ];
  }

  const options = { duration, easing, fill: 'both' };
  const outgoingAnimation = outgoing.animate(outgoingFrames, options);
  const incomingAnimation = target.animate(incomingFrames, options);
  screenTransitionAnimations = [outgoingAnimation, incomingAnimation];
  Promise.all([outgoingAnimation.finished, incomingAnimation.finished])
    .catch(() => {})
    .then(() => {
      if (transitionId !== screenTransitionId) return;
      outgoing.classList.remove('is-exiting');
      screenTransitionAnimations.forEach((animation) => animation.cancel());
      screenTransitionAnimations = [];
    });
}

async function enterPlayerAndPlay() {
  showScreen('player');
  appStatus.textContent = '已进入播放页面，正在开始播放。';
  if (currentLoadPromise) await currentLoadPromise;
  if (!audioPlayer.currentSrc) await loadCurrentSong();
  if (audioPlayer.currentSrc && audioPlayer.paused) await playAudio();
}

function enableIntroSwipe() {
  const introScreen = document.querySelector('.intro-screen');
  let startX = 0;
  let startY = 0;
  let startedInScrollableText = false;
  introScreen.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startedInScrollableText = Boolean(event.target.closest('.intro-copy.is-scrollable'));
  }, { passive: true });
  introScreen.addEventListener('touchend', (event) => {
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (!startedInScrollableText && !event.target.closest('.swipe-cue') && deltaY < -60 && Math.abs(deltaY) > Math.abs(deltaX) * 1.25) {
      enterPlayerAndPlay();
    }
    startedInScrollableText = false;
  }, { passive: true });
  introScreen.addEventListener('touchcancel', () => { startedInScrollableText = false; }, { passive: true });
}

function lockPlayerPageScroll() {
  const playerScreen = document.querySelector('.player-screen');
  playerScreen.addEventListener('touchmove', (event) => {
    if (event.target.closest('.lyrics-list, .song-seek')) return;
    event.preventDefault();
  }, { passive: false });
}

function setBusy(busy) {
  generateButton.disabled = busy;
  generateButton.setAttribute('aria-busy', String(busy));
  generateButton.classList.toggle('is-loading', busy);
  if (busy) {
    generateProgress = 0;
    generateStageCounts.clear();
    generateButton.style.setProperty('--loading-progress', '0');
  } else {
    generateProgress = 0;
    generateStageCounts.clear();
    generateButton.style.removeProperty('--loading-progress');
  }
  generateButtonLabel.textContent = busy
    ? '\u6b63\u5728\u8fde\u63a5\u751f\u6210\u670d\u52a1\u2026'
    : defaultGenerateButtonLabel;
  originInput.readOnly = busy;
  destinationInput.readOnly = busy;
  modeSelect.disabled = busy;
  modeCombobox.trigger.disabled = busy;
  if (busy) modeCombobox.close();
  if (busy) appStatus.textContent = '正在生成 Sound-Map。';
}

function advanceGenerateProgress(stage) {
  const stageBase = { '\u611f\u77e5': 18, '\u89c4\u5212': 36, '\u884c\u52a8': 58, '\u53cd\u601d': 70, '\u4fee\u6b63': 74 };
  const base = stageBase[stage];
  if (base == null) return;
  const count = (generateStageCounts.get(stage) ?? 0) + 1;
  generateStageCounts.set(stage, count);
  const repeatedStageAdvance = Math.min(14, (count - 1) * 4);
  generateProgress = Math.max(generateProgress, Math.min(90, base + repeatedStageAdvance));
  generateButton.style.setProperty('--loading-progress', String(generateProgress / 100));
}

function showError(message, field) {
  originInput.removeAttribute('aria-invalid');
  destinationInput.removeAttribute('aria-invalid');
  if (field) field.setAttribute('aria-invalid', 'true');
  formError.textContent = message;
  formError.hidden = false;
}

function clearError() {
  originInput.removeAttribute('aria-invalid');
  destinationInput.removeAttribute('aria-invalid');
  formError.textContent = '';
  formError.hidden = true;
}

function buildWaveform() {
  const heights = [14,24,34,27,31,20,15,25,17,13,21,32,27,18,16,28,36,23,14,20,29,35,24,18,14,27,32,21,15,25,30,22,16,12];
  waveform.replaceChildren(...heights.map((height, index) => {
    const bar = document.createElement('span');
    bar.style.height = `${height}px`;
    bar.style.animationDelay = `${index * -70}ms`;
    return bar;
  }));
}
