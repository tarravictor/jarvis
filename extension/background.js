// The service worker receives a narrow command from the local app and performs
// it in an existing YouTube Music tab. No account token or audio is transferred.
const ALLOWED_ACTIONS = new Set(['status', 'play', 'pause', 'stop', 'next', 'previous', 'volume-up', 'volume-down', 'mute', 'unmute']);

function isLocalJarvis(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return parsed.pathname.endsWith('/jarvis-assistant/index.html');
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  } catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'jarvis-music-action' || !ALLOWED_ACTIONS.has(message.action) || !isLocalJarvis(sender.url || sender.tab?.url)) return;

  (async () => {
    const tabs = await chrome.tabs.query({url: 'https://music.youtube.com/*'});
    if (!tabs.length) return {ok: false, code: 'NO_TAB'};
    // Prefer the audible tab; otherwise prefer the tab most recently used.
    tabs.sort((a, b) => Number(Boolean(b.audible)) - Number(Boolean(a.audible)) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const injected = await chrome.scripting.executeScript({
      target: {tabId: tabs[0].id},
      func: controlYouTubeMusic,
      args: [message.action]
    });
    return injected[0]?.result || {ok: false, code: 'BRIDGE_ERROR'};
  })().then(sendResponse).catch(() => sendResponse({ok: false, code: 'BRIDGE_ERROR'}));
  return true; // Keep the message channel open for the asynchronous tab action.
});

async function controlYouTubeMusic(action) {
  // This function is serialized into the Music tab by chrome.scripting. It must
  // use only browser globals and values defined inside this function.
  const player = document.querySelector('ytmusic-player-bar') || document;
  const media = document.querySelector('video, audio');
  const songTitle = () => player.querySelector('.title')?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube Music\s*$/i, '').trim();
  const current = () => ({ok: true, code: 'READY', title: songTitle(), playing: Boolean(media && !media.paused), volume: media ? media.volume : undefined});
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function findControl(kind) {
    const selectors = kind === 'next' ? ['#next', '.next-button', '[aria-label*="Next"]', '[title*="Next"]'] :
      kind === 'previous' ? ['#previous', '.previous-button', '[aria-label*="Previous"]', '[title*="Previous"]'] :
      ['#play-pause-button', '.play-pause-button', '[aria-label="Play"]', '[aria-label="Pause"]'];
    for (const selector of selectors) {
      const button = player.querySelector(selector) || document.querySelector(`ytmusic-player-bar ${selector}`);
      if (button && !button.disabled) return button;
    }
    const label = kind === 'next' ? /next|skip forward/i : kind === 'previous' ? /previous|skip back/i : /play|pause/i;
    return [...player.querySelectorAll('button, [role="button"], tp-yt-paper-icon-button, yt-icon-button')]
      .find((button) => label.test([button.id, button.className, button.getAttribute('aria-label'), button.getAttribute('title')].join(' ')) && !button.disabled);
  }

  if (action === 'status') return media ? current() : {ok: false, code: 'NO_MEDIA'};
  if (!media) return {ok: false, code: 'NO_MEDIA'};

  if (action === 'play') {
    if (!media.paused) return current();
    findControl('play')?.click();
    await wait(200);
    if (media.paused) {
      try { await media.play(); } catch { return {ok: false, code: 'PLAY_BLOCKED'}; }
    }
    return media.paused ? {ok: false, code: 'PLAY_BLOCKED'} : current();
  }
  if (action === 'pause' || action === 'stop') {
    media.pause();
    return current();
  }
  if (action === 'next' || action === 'previous') {
    const button = findControl(action);
    if (!button) return {ok: false, code: 'CONTROL_NOT_FOUND'};
    button.click();
    await wait(250);
    return current();
  }
  if (action === 'volume-up' || action === 'volume-down') {
    media.muted = false;
    media.volume = Math.max(0, Math.min(1, media.volume + (action === 'volume-up' ? 0.15 : -0.15)));
    return current();
  }
  if (action === 'mute' || action === 'unmute') {
    media.muted = action === 'mute';
    return current();
  }
  return {ok: false, code: 'UNSUPPORTED_ACTION'};
}
