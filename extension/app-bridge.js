(() => {
  'use strict';

  // Only the matching local Jarvis page can request a music action.
  if (!document.querySelector('#app[data-jarvis-app="true"]')) return;
  const CHANNEL = 'jarvis-youtube-music-v1';
  const actions = new Set(['status', 'play', 'pause', 'stop', 'next', 'previous', 'volume-up', 'volume-down', 'mute', 'unmute']);
  const targetOrigin = location.protocol === 'file:' ? '*' : location.origin;

  window.addEventListener('message', (event) => {
    if (event.source !== window || (location.protocol !== 'file:' && event.origin !== location.origin)) return;
    const data = event.data;
    if (data?.channel !== CHANNEL || data.type !== 'request' || typeof data.id !== 'string' || !actions.has(data.action)) return;

    chrome.runtime.sendMessage({type: 'jarvis-music-action', action: data.action}, (result) => {
      const error = chrome.runtime.lastError;
      window.postMessage({
        channel: CHANNEL,
        type: 'response',
        id: data.id,
        result: error ? {ok: false, code: 'BRIDGE_ERROR'} : result
      }, targetOrigin);
    });
  });

  window.postMessage({channel: CHANNEL, type: 'bridge-ready'}, targetOrigin);
})();
