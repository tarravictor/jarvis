(() => {
  'use strict';

  // All browser state lives here. The recognizer itself is created once and reused.
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'app','liveClock','settingsButton','modeStatus','detailStatus','interimTranscript',
    'orbCanvas','orbLevel','listeningToggle','toggleLabel','toggleHint','wakePrompt',
    'micState','noiseMeter','noiseMeterFill','noiseNote','noiseValue','wakeValue',
    'uptime','restartCount','voiceStatus','voiceHint','testVoiceButton',
    'musicBridgeStatus','musicBridgeHint','checkMusicButton',
    'chatList','chatEmpty','clearLog','textForm','textCommand',
    'tasksList','taskCount','notifyButton','permissionOverlay','permissionMessage','grantMicButton',
    'continueWithoutMic','settingsDialog','settingsForm','closeSettings',
    'wakeWordInput','weatherKeyInput','voiceSelect','confidenceInput',
    'confidenceOutput','ttsInput'
  ].map((id) => [id, $(id)]));

  const SETTINGS_KEY = 'jarvis.settings.v1';
  const TASKS_KEY = 'jarvis.tasks.v1';
  const defaults = {wakeWord: 'Jarvis', weatherKey: '', voiceURI: '', confidence: 0.6, tts: true, theme: 'dark'};
  const readStored = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const saveStored = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing may disable storage. */ }
  };
  let settings = {...defaults, ...readStored(SETTINGS_KEY, {})};
  if (typeof settings.wakeWord !== 'string' || !settings.wakeWord.trim()) settings.wakeWord = 'Jarvis';

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const state = {
    desired: Boolean(SpeechRecognition), recognition: null, recognitionState: 'idle',
    retryTimer: null, micRetryTimer: null, startWatchdog: null, retryNotBefore: 0,
    starts: 0, startedAt: Date.now(), lastError: '', detail: 'Requesting microphone access…',
    stream: null, micPromise: null, audioContext: null, source: null, analyser: null,
    samples: null, noiseBaseline: 0, noiseSamples: [], calibrating: false,
    level: 0, isSpeaking: false, voicePending: false, voiceError: '', currentSpeech: null,
    voiceWatchdog: null, processing: false, lastTranscript: '', lastTranscriptAt: 0,
    commandQueue: Promise.resolve(), tasks: [], taskTimeouts: new Map(),
    musicBridge: 'checking'
  };
  const MUSIC_CHANNEL = 'jarvis-youtube-music-v1';

  const formatTime = (date = new Date()) => date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalize = (value) => value.trim().replace(/\s+/g, ' ');
  const pad2 = (number) => String(number).padStart(2, '0');
  const formatDuration = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
    return hours ? `${hours}h ${pad2(minutes)}m` : minutes ? `${minutes}m ${pad2(seconds)}s` : `${seconds}s`;
  };

  function addLog(role, message, extra = {}) {
    ui.chatEmpty?.remove();
    const row = document.createElement('article');
    row.className = `chat-entry ${role}${extra.ignored ? ' ignored' : ''}`;
    const avatar = document.createElement('span');
    avatar.className = 'chat-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = role === 'jarvis' ? 'J' : role === 'user' ? 'U' : '·';
    const main = document.createElement('div');
    main.className = 'chat-entry-main';
    const top = document.createElement('div');
    top.className = 'chat-entry-top';
    const name = document.createElement('strong');
    name.textContent = role === 'jarvis' ? 'JARVIS' : role === 'user' ? 'YOU' : 'SYSTEM';
    const time = document.createElement('time');
    time.dateTime = new Date().toISOString();
    time.textContent = formatTime();
    top.append(name, time);
    const body = document.createElement('p');
    body.textContent = message; // Never insert recognized speech as HTML.
    main.append(top, body);
    if (extra.link) {
      const link = document.createElement('a');
      link.href = extra.link;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = extra.linkLabel || 'Open link ↗';
      main.append(link);
    }
    row.append(avatar, main);
    ui.chatList.append(row);
    while (ui.chatList.children.length > 120) ui.chatList.firstElementChild.remove();
    ui.chatList.scrollTop = ui.chatList.scrollHeight;
  }

  function updateClockAndUptime() {
    ui.liveClock.textContent = formatTime();
    const seconds = state.desired ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
    ui.uptime.textContent = `${pad2(Math.floor(seconds / 3600))}:${pad2(Math.floor((seconds % 3600) / 60))}:${pad2(seconds % 60)}`;
    ui.restartCount.textContent = pad2(Math.max(0, state.starts - 1));
  }

  function updateStatus() {
    updateVoicePanel();
    ui.app.dataset.state = state.isSpeaking ? 'speaking' : 'idle';
    ui.listeningToggle.setAttribute('aria-pressed', String(state.desired));
    ui.toggleLabel.textContent = `Always Listening: ${state.desired ? 'ON' : 'OFF'}`;
    ui.toggleHint.textContent = state.desired ? 'Click to stop the assistant' : 'Click to resume listening';
    if (!SpeechRecognition) {
      ui.modeStatus.textContent = 'VOICE RECOGNITION UNAVAILABLE';
      ui.detailStatus.textContent = 'Please use Chrome or Edge for full voice features. Text commands still work.';
      ui.micState.textContent = 'UNSUPPORTED';
      return;
    }
    if (!state.desired) {
      ui.modeStatus.textContent = 'VOICE INTERFACE STANDBY';
      ui.detailStatus.textContent = 'Listening stopped. Text commands remain available.';
      ui.micState.textContent = 'STOPPED';
      return;
    }
    ui.modeStatus.textContent = state.calibrating ? 'CALIBRATING MIC...' : '🎙️ Listening... (always on)';
    ui.detailStatus.textContent = state.calibrating ? 'Sampling ambient noise for 3 seconds…' : state.detail;
    ui.micState.textContent = !state.stream ? (state.lastError === 'audio-capture' ? 'NO MIC DETECTED' : state.lastError === 'not-allowed' ? 'PERMISSION BLOCKED' : 'RECONNECTING') : state.recognitionState === 'listening' ? 'CONNECTED' : 'RECOVERING';
    ui.app.dataset.state = state.isSpeaking ? 'speaking' : state.processing ? 'processing' : state.recognitionState === 'listening' ? 'listening' : 'idle';
  }

  function setDetail(message, error = '') {
    state.detail = message;
    state.lastError = error;
    updateStatus();
  }

  function playBeep(high = true) {
    const context = state.audioContext;
    if (!context || context.state !== 'running') return;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(high ? 660 : 450, now);
      oscillator.frequency.exponentialRampToValueAtTime(high ? 880 : 330, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.045, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.17);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.18);
    } catch { /* An audio device can disappear during playback. */ }
  }

  function unlockAudio() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    try {
      state.audioContext ||= new AudioContext();
      state.audioContext.resume().catch(() => {});
    } catch { /* Audio is optional when the browser has no output device. */ }
  }

  // getUserMedia supplies the meter and a browser-processed audio track. Where the
  // browser supports start(audioTrack), recognition uses that same track.
  async function ensureMicrophone() {
    if (!state.desired) return false;
    if (state.stream?.getAudioTracks().some((track) => track.readyState === 'live')) return true;
    if (state.micPromise) return state.micPromise;
    if (!navigator.mediaDevices?.getUserMedia) {
      ui.permissionMessage.textContent = 'Microphone access requires HTTPS or localhost in Chrome or Edge.';
      setDetail('Microphone access requires HTTPS or localhost.', 'audio-capture');
      return false;
    }
    state.micPromise = (async () => {
      try {
        ui.permissionMessage.textContent = 'Requesting microphone access…';
        const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}});
        if (!state.desired) { stream.getTracks().forEach((track) => track.stop()); return false; }
        state.stream = stream;
        stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => {
          if (state.stream === stream) state.stream = null;
          if (state.desired) { setDetail('Microphone disconnected. Reconnecting…', 'audio-capture'); scheduleMicRetry(3000); }
        }, {once: true}));
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          state.audioContext ||= new AudioContext();
          // Do not await resume: autoplay policy can leave it pending until a click.
          state.audioContext.resume().catch(() => {});
          state.source?.disconnect();
          state.analyser ||= state.audioContext.createAnalyser();
          state.analyser.fftSize = 2048;
          state.analyser.smoothingTimeConstant = 0.7;
          state.samples = new Float32Array(state.analyser.fftSize);
          state.source = state.audioContext.createMediaStreamSource(stream);
          state.source.connect(state.analyser);
        }
        state.noiseSamples = [];
        state.calibrating = true;
        ui.noiseNote.textContent = 'Calibrating mic...';
        ui.permissionOverlay.hidden = true;
        updateStatus();
        setTimeout(() => {
          if (!state.desired || state.stream !== stream) return;
          const sorted = state.noiseSamples.slice().sort((a, b) => a - b);
          state.noiseBaseline = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;
          state.calibrating = false;
          ui.noiseNote.textContent = `Ready · floor ${Math.round(state.noiseBaseline * 430)}%`;
          setDetail(state.recognitionState === 'listening' ? 'Ready. Say your wake word to begin.' : 'Ready. Reconnecting speech service…');
        }, 3000);
        return true;
      } catch (error) {
        const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
        ui.permissionMessage.textContent = denied ? 'Permission denied. Use your browser settings, then reconnect.' : 'No mic detected. Check your device, then reconnect.';
        setDetail(denied ? 'Microphone permission denied. Reconnecting when allowed…' : 'No mic detected. Retrying…', denied ? 'not-allowed' : 'audio-capture');
        scheduleMicRetry(denied ? 5000 : 3000);
        return false;
      } finally { state.micPromise = null; }
    })();
    return state.micPromise;
  }

  function scheduleMicRetry(delay) {
    // A denied or disconnected mic is retried until the user stops the session.
    if (!state.desired) return;
    clearTimeout(state.micRetryTimer);
    state.micRetryTimer = setTimeout(() => { ensureMicrophone(); }, delay);
  }

  function createRecognition() {
    // Keep one recognizer for the entire page lifetime. End/error events reuse it.
    if (state.recognition || !SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-US';
    recognition.maxAlternatives = 1;
    state.recognition = recognition;

    recognition.onstart = () => {
      clearTimeout(state.startWatchdog);
      state.recognitionState = 'listening';
      state.starts++;
      state.retryNotBefore = 0;
      setDetail('Ready. Say your wake word to begin.');
    };
    recognition.onend = () => {
      clearTimeout(state.startWatchdog);
      state.recognitionState = 'idle';
      if (state.desired) {
        setDetail(state.lastError ? state.detail : 'Speech service restarted automatically.');
        scheduleRecognitionStart(Math.max(250, state.retryNotBefore - Date.now()));
      } else updateStatus();
    };
    recognition.onerror = (event) => {
      if (!state.desired) return;
      const code = event.error || 'unknown';
      const recovery = {
        'no-speech': [300, null],
        'audio-capture': [3000, 'No mic detected. Retrying in 3 seconds…'],
        'not-allowed': [5000, 'Microphone blocked. Use browser permissions, then reconnect.'],
        'network': [1000, 'Speech network error. Reconnecting…'],
        'aborted': [0, null],
        'service-not-allowed': [2000, 'Speech service unavailable. Retrying…']
      };
      const [delay, message] = recovery[code] || [1000, `Speech error (${code}). Reconnecting…`];
      state.retryNotBefore = Date.now() + delay;
      if (message) setDetail(message, code);
      if (code === 'audio-capture' || code === 'not-allowed') scheduleMicRetry(delay);
      // onend normally follows an error. This watchdog recovers if it does not.
      clearTimeout(state.startWatchdog);
      state.startWatchdog = setTimeout(() => {
        if (state.desired && state.recognitionState !== 'idle') {
          try { recognition.abort(); } catch { state.recognitionState = 'idle'; }
        }
        scheduleRecognitionStart(Math.max(250, state.retryNotBefore - Date.now()));
      }, Math.max(800, delay));
      scheduleRecognitionStart(delay);
    };
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = normalize(result[0]?.transcript || '');
        if (!text) continue;
        if (result.isFinal) {
          ui.interimTranscript.textContent = '';
          const confidence = result[0]?.confidence || 0;
          state.commandQueue = state.commandQueue.then(() => handleVoice(text, confidence)).catch((error) => {
            addLog('system', `Command error: ${error.message || 'unknown error'}`);
          });
        } else interim = text;
      }
      if (interim) ui.interimTranscript.textContent = `“${interim}”`;
    };
    // These events do not mean recognition stopped. Restart only if it is idle;
    // restarting an active recognizer would cause InvalidStateError.
    const recoverIfIdle = () => {
      if (state.desired && state.recognitionState === 'idle') scheduleRecognitionStart(250);
    };
    recognition.onaudiostart = recoverIfIdle;
    recognition.onspeechend = recoverIfIdle;
    recognition.onnomatch = recoverIfIdle;
  }

  function scheduleRecognitionStart(delay = 250) {
    // A single timer and the idle-state guard prevent overlapping start() calls.
    if (!state.desired || !state.recognition) return;
    clearTimeout(state.retryTimer);
    const wait = Math.max(0, delay, state.retryNotBefore - Date.now());
    state.retryTimer = setTimeout(startRecognition, wait);
  }

  function startRecognition() {
    if (!state.desired || !state.recognition || state.recognitionState !== 'idle') return;
    clearTimeout(state.retryTimer);
    try {
      state.recognitionState = 'starting';
      const track = state.stream?.getAudioTracks().find((item) => item.readyState === 'live');
      if (track) {
        try { state.recognition.start(track); }
        catch (error) {
          if (error?.name === 'TypeError' || error?.name === 'NotSupportedError') state.recognition.start();
          else throw error;
        }
      } else state.recognition.start();
      updateStatus();
      state.startWatchdog = setTimeout(() => {
        if (state.desired && state.recognitionState === 'starting') {
          state.recognitionState = 'idle';
          scheduleRecognitionStart(500);
        }
      }, 4000);
    } catch (error) {
      state.recognitionState = 'idle';
      // InvalidStateError is common while Chrome is still releasing its last session.
      scheduleRecognitionStart(error?.name === 'InvalidStateError' ? 250 : 1000);
    }
  }

  async function startAssistant() {
    if (!SpeechRecognition) {
      ui.permissionOverlay.hidden = true;
      addLog('system', 'Please use Chrome or Edge for full voice features. Typed commands are available.');
      updateStatus();
      return;
    }
    const wasOff = !state.desired;
    state.desired = true;
    if (wasOff) { state.startedAt = Date.now(); state.starts = 0; }
    createRecognition();
    updateStatus();
    await ensureMicrophone();
    if (state.desired) {
      scheduleRecognitionStart(0);
      if (wasOff) playBeep(true);
    }
  }

  function stopAssistant() {
    state.desired = false;
    state.calibrating = false;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    clearTimeout(state.voiceWatchdog);
    state.currentSpeech = null;
    state.isSpeaking = false;
    state.voicePending = false;
    clearTimeout(state.retryTimer);
    clearTimeout(state.micRetryTimer);
    clearTimeout(state.startWatchdog);
    state.retryTimer = state.micRetryTimer = state.startWatchdog = null;
    state.retryNotBefore = 0;
    try { state.recognition?.abort(); } catch { /* It may already be stopped. */ }
    state.recognitionState = 'idle';
    playBeep(false);
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    state.source?.disconnect();
    state.source = null;
    state.level = 0;
    ui.noiseNote.textContent = 'Microphone stopped';
    updateStatus();
  }

  function getWakeMatch(transcript) {
    const word = escapeRegExp(settings.wakeWord.trim());
    const optionalHey = /^hey\s/i.test(settings.wakeWord) ? '' : '(?:hey[\\s,]+)?';
    const expression = new RegExp(`^${optionalHey}${word}(?=$|[\\s,.:!?-])[\\s,.:!?-]*`, 'i');
    return transcript.match(expression);
  }

  async function handleVoice(transcript, confidence) {
    const now = Date.now();
    const duplicate = transcript.toLowerCase() === state.lastTranscript && now - state.lastTranscriptAt < 1500;
    state.lastTranscript = transcript.toLowerCase();
    state.lastTranscriptAt = now;
    const wake = getWakeMatch(transcript);
    addLog('user', transcript, {ignored: duplicate || !wake || state.isSpeaking || state.voicePending});
    if (duplicate) { addLog('system', 'Duplicate phrase ignored.', {ignored: true}); return; }
    if (state.isSpeaking || state.voicePending) { addLog('system', 'Ignored while Jarvis was speaking.', {ignored: true}); return; }
    if (!wake) {
      const reason = confidence <= settings.confidence ? 'Low-confidence phrase without the wake word.' : `Ignored. Say “${settings.wakeWord}” first.`;
      addLog('system', reason, {ignored: true});
      return;
    }
    // A wake word is the explicit exception to the confidence threshold.
    const command = normalize(transcript.slice(wake[0].length));
    await executeCommand(command || 'hello');
  }

  async function executeCommand(transcript) {
    state.processing = true;
    updateStatus();
    let reply;
    try {
      const command = Object.values(commands).find(({patterns}) => patterns.some((pattern) => pattern.test(transcript)));
      const match = command?.patterns.map((pattern) => transcript.match(pattern)).find(Boolean);
      reply = command ? await command.handler(match, transcript) : {text: `I don't know that command yet. Try asking for the time, weather, music, a timer, or a search.`};
    } catch (error) {
      reply = {text: `I couldn't complete that: ${error.message || 'something went wrong'}.`};
    }
    if (typeof reply === 'string') reply = {text: reply};
    state.processing = false;
    addLog('jarvis', reply.text, reply);
    updateStatus();
    speak(reply.text);
  }

  function populateVoices() {
    const voices = speechSynthesis.getVoices();
    const selected = settings.voiceURI;
    ui.voiceSelect.replaceChildren(new Option('Automatic English voice', ''));
    voices.filter((voice) => voice.lang.toLowerCase().startsWith('en')).forEach((voice) => {
      ui.voiceSelect.add(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI));
    });
    ui.voiceSelect.value = selected;
    updateVoicePanel();
  }

  function selectedVoice() {
    const voices = speechSynthesis.getVoices();
    return voices.find((voice) => voice.voiceURI === settings.voiceURI) ||
      voices.find((voice) => /en[-_]gb/i.test(voice.lang) && /male|daniel|oliver|arthur|george/i.test(voice.name)) ||
      voices.find((voice) => /en[-_]gb/i.test(voice.lang)) ||
      voices.find((voice) => /^en/i.test(voice.lang));
  }

  function updateVoicePanel() {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      ui.voiceStatus.textContent = 'VOICE OUTPUT UNAVAILABLE';
      ui.voiceHint.textContent = 'This browser does not support spoken replies.';
      return;
    }
    const voice = selectedVoice();
    ui.voiceStatus.textContent = state.voiceError ? 'VOICE NEEDS ATTENTION' :
      state.isSpeaking ? 'JARVIS IS SPEAKING' : state.voicePending ? 'STARTING VOICE...' :
      !settings.tts ? 'SPOKEN REPLIES OFF' : 'READY TO SPEAK';
    ui.voiceHint.textContent = state.voiceError || (!settings.tts && !state.isSpeaking && !state.voicePending ? 'Turn on spoken responses in Settings.' :
      `${voice?.name || 'Browser voice'} · Replies play after each command.`);
  }

  function speak(message, force = false) {
    if ((!settings.tts && !force) || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      updateVoicePanel();
      return;
    }
    clearTimeout(state.voiceWatchdog);
    speechSynthesis.cancel();
    try { speechSynthesis.resume(); } catch { /* Some browsers expose synthesis without resume. */ }
    const utterance = new SpeechSynthesisUtterance(message);
    state.currentSpeech = utterance;
    state.voicePending = true;
    state.voiceError = '';
    utterance.voice = selectedVoice() || null;
    utterance.lang = utterance.voice?.lang || 'en-GB';
    utterance.rate = 1.02;
    utterance.pitch = 0.92;
    utterance.onstart = () => {
      if (state.currentSpeech !== utterance) return;
      clearTimeout(state.voiceWatchdog);
      state.voicePending = false;
      state.isSpeaking = true;
      state.voiceError = '';
      updateStatus();
    };
    utterance.onend = () => {
      if (state.currentSpeech !== utterance) return;
      clearTimeout(state.voiceWatchdog);
      state.currentSpeech = null;
      state.voicePending = state.isSpeaking = false;
      updateStatus();
    };
    utterance.onerror = (event) => {
      if (state.currentSpeech !== utterance) return;
      clearTimeout(state.voiceWatchdog);
      state.currentSpeech = null;
      state.voicePending = state.isSpeaking = false;
      state.voiceError = event.error === 'interrupted' ? '' : 'Click Test Voice and check your browser audio settings.';
      updateStatus();
    };
    updateVoicePanel();
    try {
      speechSynthesis.speak(utterance);
      if (state.voicePending) {
        state.voiceWatchdog = setTimeout(() => {
          if (state.currentSpeech === utterance && state.voicePending) {
            state.voicePending = false;
            state.voiceError = 'Voice did not start. Click Test Voice to unlock audio.';
            updateVoicePanel();
          }
        }, 2500);
      }
    } catch {
      state.currentSpeech = null;
      state.voicePending = state.isSpeaking = false;
      state.voiceError = 'Voice could not start in this browser.';
      updateStatus();
    }
  }

  function openExternal(url, label) {
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* Link remains in the chat. */ }
    return {text: `Opening ${label}. If your browser blocks the new tab, use the link below.`, link: url, linkLabel: `Open ${label} ↗`};
  }

  function parseDuration(amount, unit) {
    const multipliers = {second: 1000, minute: 60000, hour: 3600000};
    const singular = unit.toLowerCase().replace(/s$/, '');
    const ms = Number(amount) * multipliers[singular];
    if (!Number.isFinite(ms) || ms < 1000 || ms > 86400000) throw new Error('Choose a duration between one second and 24 hours');
    return ms;
  }

  function persistTasks() {
    // Timeouts are recreated from their due timestamps after a page reload.
    saveStored(TASKS_KEY, state.tasks.map(({id, type, label, due}) => ({id, type, label, due})));
    renderTasks();
  }

  function renderTasks() {
    ui.taskCount.textContent = pad2(state.tasks.length);
    ui.tasksList.replaceChildren();
    if (!state.tasks.length) {
      const empty = document.createElement('p');
      empty.className = 'no-tasks';
      empty.textContent = 'No timers or reminders set.';
      ui.tasksList.append(empty);
      return;
    }
    [...state.tasks].sort((a, b) => a.due - b.due).forEach((task) => {
      const row = document.createElement('div'); row.className = 'task-row';
      const label = document.createElement('strong'); label.textContent = task.label;
      const time = document.createElement('span'); time.textContent = formatDuration(task.due - Date.now());
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '×'; cancel.title = 'Cancel alert'; cancel.setAttribute('aria-label', `Cancel ${task.label}`);
      cancel.addEventListener('click', () => removeTask(task.id));
      row.append(label, time, cancel); ui.tasksList.append(row);
    });
  }

  function removeTask(id) {
    clearTimeout(state.taskTimeouts.get(id));
    state.taskTimeouts.delete(id);
    state.tasks = state.tasks.filter((task) => task.id !== id);
    persistTasks();
  }

  function fireTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    removeTask(id);
    const message = task.type === 'timer' ? 'Your timer is complete.' : `Reminder: ${task.label}`;
    addLog('jarvis', message);
    playBeep(true);
    setTimeout(() => playBeep(true), 220);
    speak(message);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('J.A.R.V.I.S.', {body: message}); } catch { /* A suspended browser may block notification. */ }
    }
  }

  function scheduleTask(type, label, delay) {
    // setTimeout is precise while the page runs; visibility checks catch late alerts.
    const task = {id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, type, label, due: Date.now() + delay};
    state.tasks.push(task);
    state.taskTimeouts.set(task.id, setTimeout(() => fireTask(task.id), delay));
    persistTasks();
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(updateNotificationButton).catch(() => {});
    }
    return `Consider it done. ${type === 'timer' ? 'Timer' : 'Reminder'} set for ${formatDuration(delay)}.`;
  }

  function restoreTasks() {
    const saved = readStored(TASKS_KEY, []);
    state.tasks = Array.isArray(saved) ? saved.filter((task) => task && typeof task.id === 'string' && Number.isFinite(task.due) && typeof task.label === 'string') : [];
    state.tasks.forEach((task) => state.taskTimeouts.set(task.id, setTimeout(() => fireTask(task.id), Math.max(0, task.due - Date.now()))));
    renderTasks();
  }

  function calculateSimpleMath(left, operator, right) {
    const a = Number(left), b = Number(right);
    const op = operator.toLowerCase();
    const result = op === 'plus' || op === '+' ? a + b : op === 'minus' || op === '-' ? a - b :
      op === 'times' || op === 'multiplied by' || op === '*' ? a * b : b === 0 ? NaN : a / b;
    if (!Number.isFinite(result)) return 'Division by zero is undefined.';
    return `${a} ${operator} ${b} equals ${Number(result.toPrecision(12))}.`;
  }

  // Add a new intent by adding one {patterns, handler} entry to this object.
  // A handler may return a string or {text, link, linkLabel}; async is supported.
  const commands = {
    stopListening: {patterns: [/^stop listening\b/i], handler: () => { stopAssistant(); return 'Going quiet. Press Always Listening to wake me again.'; }},
    greeting: {patterns: [/^(?:hello|hi|hey|are you there)\b/i], handler: () => 'At your service. What can I do for you?'},
    time: {patterns: [/^(?:what(?:'s| is) the time|what time is it|tell me the time|time)\??$/i], handler: () => `It is ${new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}.`},
    date: {patterns: [/^(?:what(?:'s| is) the date|today(?:'s| is)? date|date)\??$/i], handler: () => `Today is ${new Date().toLocaleDateString([], {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})}.`},
    day: {patterns: [/^(?:what day is it|what(?:'s| is) today)\??$/i], handler: () => `It's ${new Date().toLocaleDateString([], {weekday: 'long'})}.`},
    google: {patterns: [/^search (?:google|the web) for (.+)$/i], handler: (match) => openExternal(`https://www.google.com/search?q=${encodeURIComponent(match[1])}`, `Google search for “${match[1]}”`)},
    youtubeSearch: {patterns: [/^search youtube for (.+)$/i], handler: (match) => openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(match[1])}`, `YouTube search for “${match[1]}”`)},
    wikipedia: {patterns: [/^(?:wikipedia|search wikipedia for) (.+)$/i], handler: (match) => openExternal(`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(match[1])}`, `Wikipedia search for “${match[1]}”`)},
    weather: {patterns: [/^(?:what(?:'s| is) the )?weather (?:in|for) (.+?)\??$/i], handler: async (match) => {
      if (!settings.weatherKey.trim()) return 'Add an OpenWeatherMap API key in Settings to use weather.';
      const city = match[1].replace(/[?.!]+$/, '').trim();
      const key = encodeURIComponent(settings.weatherKey.trim());
      const geoResponse = await fetch(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${key}`);
      if (geoResponse.status === 401) return 'The weather API key was rejected. Check it in Settings.';
      if (!geoResponse.ok) return `The weather service returned an error (${geoResponse.status}).`;
      const locations = await geoResponse.json();
      if (!locations.length) return `I couldn't find weather for ${city}.`;
      const location = locations[0];
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${location.lat}&lon=${location.lon}&appid=${key}&units=metric`;
      const response = await fetch(url);
      if (response.status === 401) return 'The weather API key was rejected. Check it in Settings.';
      if (response.status === 404) return `I couldn't find weather for ${city}.`;
      if (!response.ok) return `The weather service returned an error (${response.status}).`;
      const data = await response.json();
      const temp = Math.round(data.main.temp), feels = Math.round(data.main.feels_like);
      return `In ${data.name}, it's ${temp}°C with ${data.weather[0].description}. It feels like ${feels}°C.`;
    }},
    timer: {patterns: [/^set (?:a )?timer for (\d+(?:\.\d+)?) (seconds?|minutes?|hours?)\b/i], handler: (match) => scheduleTask('timer', 'Timer', parseDuration(match[1], match[2]))},
    reminder: {patterns: [/^remind me to (.+?) in (\d+(?:\.\d+)?) (seconds?|minutes?|hours?)\b/i], handler: (match) => scheduleTask('reminder', match[1], parseDuration(match[2], match[3]))},
    playMusic: {patterns: [/^(?:play(?: music| song)?|resume(?: music)?)\b/i], handler: () => musicCommand('play')},
    pauseMusic: {patterns: [/^(?:pause(?: music)?|pause song)\b/i], handler: () => musicCommand('pause')},
    stopMusic: {patterns: [/^stop music\b/i], handler: () => musicCommand('stop')},
    nextTrack: {patterns: [/^(?:skip(?: song| track)?|next(?: track| song)?)\b/i], handler: () => musicCommand('next')},
    previousTrack: {patterns: [/^(?:previous(?: song| track)?|last song|back)\b/i], handler: () => musicCommand('previous')},
    volumeUp: {patterns: [/^volume up\b/i], handler: () => musicCommand('volume-up')},
    volumeDown: {patterns: [/^volume down\b/i], handler: () => musicCommand('volume-down')},
    mute: {patterns: [/^mute\b/i], handler: () => musicCommand('mute')},
    unmute: {patterns: [/^unmute\b/i], handler: () => musicCommand('unmute')},
    fullscreen: {patterns: [/^(?:go|enter) fullscreen\b/i], handler: async () => {
      try { await document.documentElement.requestFullscreen(); return 'Fullscreen engaged.'; }
      catch { return 'Use the fullscreen button in your browser if it blocked this voice command.'; }
    }},
    exitFullscreen: {patterns: [/^exit fullscreen\b/i], handler: async () => {
      try { if (document.fullscreenElement) await document.exitFullscreen(); return 'Fullscreen disengaged.'; }
      catch { return 'I could not exit fullscreen from this browser.'; }
    }},
    darkMode: {patterns: [/^dark mode\b/i], handler: () => { settings.theme = 'dark'; applyTheme(); saveStored(SETTINGS_KEY, settings); return 'Dark mode enabled.'; }},
    lightMode: {patterns: [/^light mode\b/i], handler: () => { settings.theme = 'light'; applyTheme(); saveStored(SETTINGS_KEY, settings); return 'Light mode enabled.'; }},
    joke: {patterns: [/^tell me a joke\b/i], handler: () => [
      'Why did the computer take a nap? It had too many tabs open.',
      'I told my circuits a joke. They found it shocking.',
      'Why was the robot so calm? It had excellent self-control.'
    ][Math.floor(Math.random() * 3)]},
    coin: {patterns: [/^flip a coin\b/i], handler: () => `The coin lands on ${Math.random() < 0.5 ? 'heads' : 'tails'}.`},
    dice: {patterns: [/^roll (?:a |the )?(?:dice|die)\b/i], handler: () => `You rolled a ${1 + Math.floor(Math.random() * 6)}.`},
    name: {patterns: [/^what(?:'s| is) your name\b/i], handler: () => 'J.A.R.V.I.S. At your service.'},
    math: {patterns: [/^(?:what is|what's|calculate)\s+(-?\d+(?:\.\d+)?)\s+(plus|minus|times|multiplied by|divided by|over|\+|-|\*|\/)\s+(-?\d+(?:\.\d+)?)\??$/i], handler: (match) => calculateSimpleMath(match[1], match[2], match[3])},
    openSite: {patterns: [/^open (.+)$/i], handler: (match) => {
      const name = match[1].trim().toLowerCase().replace(/[?.!]+$/, '');
      const sites = {youtube: 'https://www.youtube.com', gmail: 'https://mail.google.com', google: 'https://www.google.com', wikipedia: 'https://en.wikipedia.org', github: 'https://github.com', reddit: 'https://www.reddit.com', spotify: 'https://open.spotify.com'};
      const url = sites[name] || (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i.test(name) ? `https://${name}` : `https://www.google.com/search?q=${encodeURIComponent(name)}`);
      return openExternal(url, name);
    }}
  };

  // A companion extension relays these tiny requests to the separate Music tab.
  // This page never receives YouTube credentials or audio data.
  function musicBridgeRequest(action, timeout = 4000) {
    return new Promise((resolve) => {
      const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      const targetOrigin = location.protocol === 'file:' ? '*' : location.origin;
      const timer = setTimeout(() => finish({ok: false, code: 'NO_BRIDGE'}), timeout);
      function finish(result) {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(result);
      }
      function onMessage(event) {
        if (event.source !== window || (location.protocol !== 'file:' && event.origin !== location.origin)) return;
        const data = event.data;
        if (data?.channel !== MUSIC_CHANNEL || data.type !== 'response' || data.id !== id) return;
        finish(data.result && typeof data.result === 'object' ? data.result : {ok: false, code: 'BRIDGE_ERROR'});
      }
      window.addEventListener('message', onMessage);
      window.postMessage({channel: MUSIC_CHANNEL, type: 'request', id, action}, targetOrigin);
    });
  }

  function showMusicBridge(result) {
    const code = result?.code || (result?.ok ? 'READY' : 'BRIDGE_ERROR');
    state.musicBridge = code;
    if (code === 'NO_BRIDGE') {
      ui.musicBridgeStatus.textContent = 'EXTENSION NOT CONNECTED';
      ui.musicBridgeHint.textContent = location.protocol === 'file:' ?
        'Open Jarvis in Chrome, Edge, or Brave and enable extension file access.' :
        'Open Jarvis in Chrome, Edge, or Brave with the extension installed.';
    } else if (code === 'NO_TAB') {
      ui.musicBridgeStatus.textContent = 'OPEN YOUTUBE MUSIC';
      ui.musicBridgeHint.textContent = 'The bridge is ready. Open music.youtube.com in this browser.';
    } else if (code === 'NO_MEDIA') {
      ui.musicBridgeStatus.textContent = 'CHOOSE A SONG';
      ui.musicBridgeHint.textContent = 'YouTube Music is open. Start a song there first.';
    } else if (result?.ok) {
      ui.musicBridgeStatus.textContent = 'YOUTUBE MUSIC CONNECTED';
      ui.musicBridgeHint.textContent = result.title ? `${result.title} · ${result.playing ? 'playing' : 'paused'}` : 'Ready for play, pause, and skip commands.';
    } else {
      ui.musicBridgeStatus.textContent = 'MUSIC LINK ERROR';
      ui.musicBridgeHint.textContent = 'Reload YouTube Music and check extension site access.';
    }
  }

  async function checkMusicBridge() {
    ui.musicBridgeStatus.textContent = 'CHECKING CONNECTION';
    const result = await musicBridgeRequest('status', 1500);
    showMusicBridge(result);
    return result;
  }

  async function musicCommand(action) {
    const result = await musicBridgeRequest(action);
    showMusicBridge(result);
    if (result.ok) {
      const replies = {
        play: 'Right away. YouTube Music is playing.', pause: 'Music paused.',
        stop: 'Music paused.', next: 'Skipping to the next song.',
        previous: 'Back to the previous song.', 'volume-up': 'Volume raised.',
        'volume-down': 'Volume lowered.', mute: 'Music muted.', unmute: 'Music unmuted.'
      };
      return action === 'volume-up' || action === 'volume-down' ?
        `${replies[action]} ${Math.round(result.volume * 100)} percent.` : replies[action];
    }
    if (result.code === 'NO_BRIDGE') return 'To control YouTube Music, load the companion extension from the Jarvis folder. The setup guide has the steps.';
    if (result.code === 'NO_TAB') return {text: 'Open YouTube Music in another tab and start a song first.', link: 'https://music.youtube.com/', linkLabel: 'Open YouTube Music ↗'};
    if (result.code === 'NO_MEDIA') return 'Choose a song in YouTube Music first.';
    if (result.code === 'CONTROL_NOT_FOUND') return 'I could not find that YouTube Music control. Reload the Music tab and try again.';
    if (result.code === 'PLAY_BLOCKED') return 'Your browser blocked playback. Click Play in YouTube Music once, then ask me again.';
    return 'I could not reach YouTube Music. Check the extension and reload the Music tab.';
  }

  function applyTheme() { document.body.dataset.theme = settings.theme === 'light' ? 'light' : 'dark'; }

  function drawOrb() {
    const canvas = ui.orbCanvas, context = canvas.getContext('2d');
    const size = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr); }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size, size);
    if (state.analyser && state.stream) {
      state.analyser.getFloatTimeDomainData(state.samples);
      let sum = 0;
      for (const sample of state.samples) sum += sample * sample;
      const rms = Math.sqrt(sum / state.samples.length);
      state.level = state.level * 0.74 + rms * 0.26;
      if (state.calibrating) state.noiseSamples.push(rms);
    } else state.level *= 0.9;
    const levelPercent = Math.min(100, Math.round(state.level * 430));
    const activityPercent = Math.min(100, Math.round(Math.max(0, state.level - state.noiseBaseline) * 430));
    ui.noiseMeterFill.style.width = `${levelPercent}%`;
    ui.noiseMeter.setAttribute('aria-valuenow', String(levelPercent));
    ui.noiseValue.textContent = `${levelPercent}%`;
    ui.orbLevel.textContent = `${pad2(levelPercent)}%`;
    const center = size / 2, radius = size * 0.25;
    const bars = 84;
    for (let i = 0; i < bars; i++) {
      const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const flutter = Math.sin(i * 1.9 + performance.now() / 190) * 0.5 + 0.5;
      const speaking = state.isSpeaking ? 13 + flutter * 20 : 0;
      const height = 4 + flutter * (activityPercent * 0.34 + speaking);
      const x1 = center + Math.cos(angle) * radius, y1 = center + Math.sin(angle) * radius;
      const x2 = center + Math.cos(angle) * (radius + height), y2 = center + Math.sin(angle) * (radius + height);
      context.strokeStyle = `rgba(82,232,244,${0.22 + (activityPercent / 100) * 0.6 + (state.isSpeaking ? 0.2 : 0)})`;
      context.lineWidth = i % 4 === 0 ? 2 : 1;
      context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke();
    }
    requestAnimationFrame(drawOrb);
  }

  function wireUI() {
    // All user gestures are registered here so typed mode works without the mic.
    ui.listeningToggle.addEventListener('click', () => {
      unlockAudio();
      if (state.desired) stopAssistant();
      else { speak('Jarvis online. I am listening.'); startAssistant(); }
    });
    ui.grantMicButton.addEventListener('click', () => { unlockAudio(); speak('Jarvis online. I am listening.'); startAssistant(); });
    ui.continueWithoutMic.addEventListener('click', () => {
      unlockAudio(); stopAssistant(); ui.permissionOverlay.hidden = true;
      speak('Text mode ready. Type a command and I will reply.');
    });
    ui.testVoiceButton.addEventListener('click', () => {
      unlockAudio();
      const hour = new Date().getHours();
      const greeting = `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}. Jarvis online and ready to assist you.`;
      addLog('jarvis', greeting);
      speak(greeting, true);
    });
    ui.checkMusicButton.addEventListener('click', () => checkMusicBridge());
    window.addEventListener('message', (event) => {
      if (event.source !== window || (location.protocol !== 'file:' && event.origin !== location.origin)) return;
      if (event.data?.channel === MUSIC_CHANNEL && event.data.type === 'bridge-ready') checkMusicBridge();
    });
    ui.settingsButton.addEventListener('click', () => { fillSettings(); ui.settingsDialog.showModal(); });
    ui.closeSettings.addEventListener('click', () => ui.settingsDialog.close());
    ui.confidenceInput.addEventListener('input', () => { ui.confidenceOutput.value = Number(ui.confidenceInput.value).toFixed(2); });
    ui.settingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      settings = {...settings, wakeWord: normalize(ui.wakeWordInput.value) || 'Jarvis', weatherKey: ui.weatherKeyInput.value.trim(), voiceURI: ui.voiceSelect.value, confidence: Number(ui.confidenceInput.value), tts: ui.ttsInput.checked};
      if (!settings.tts && 'speechSynthesis' in window) {
        speechSynthesis.cancel(); clearTimeout(state.voiceWatchdog);
        state.currentSpeech = null; state.voicePending = state.isSpeaking = false;
      }
      saveStored(SETTINGS_KEY, settings);
      updateVoicePanel();
      ui.wakeValue.textContent = settings.wakeWord.toUpperCase();
      ui.wakePrompt.textContent = `“HEY ${settings.wakeWord.toUpperCase()}”`;
      ui.settingsDialog.close();
      addLog('system', 'Settings saved.');
    });
    ui.textForm.addEventListener('submit', (event) => {
      event.preventDefault();
      unlockAudio();
      const text = normalize(ui.textCommand.value);
      if (!text) return;
      ui.textCommand.value = '';
      addLog('user', text);
      const wake = getWakeMatch(text);
      const commandText = wake ? normalize(text.slice(wake[0].length)) : text;
      state.commandQueue = state.commandQueue.then(() => executeCommand(commandText || 'hello')).catch((error) => addLog('system', error.message));
    });
    ui.clearLog.addEventListener('click', () => { ui.chatList.replaceChildren(); addLog('system', 'Conversation log cleared.'); });
    ui.notifyButton.addEventListener('click', async () => {
      unlockAudio();
      if (!('Notification' in window)) { addLog('system', 'Browser notifications are unavailable here. Alerts still appear in the conversation.'); return; }
      if (Notification.permission === 'granted') { addLog('system', 'Notifications are already enabled.'); return; }
      const permission = await Notification.requestPermission().catch(() => 'denied');
      addLog('system', permission === 'granted' ? 'Notifications enabled for timers and reminders.' : 'Notifications were not enabled. Alerts still appear in the conversation.');
      updateNotificationButton();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.desired) {
        ensureMicrophone();
        if (state.recognitionState === 'listening') {
          try { state.recognition.abort(); } catch { scheduleRecognitionStart(250); }
        } else scheduleRecognitionStart(250);
      }
      if (!document.hidden) {
        state.tasks.filter((task) => task.due <= Date.now()).forEach((task) => fireTask(task.id));
        checkMusicBridge();
      }
    });
  }

  function fillSettings() {
    ui.wakeWordInput.value = settings.wakeWord;
    ui.weatherKeyInput.value = settings.weatherKey;
    ui.voiceSelect.value = settings.voiceURI;
    ui.confidenceInput.value = settings.confidence;
    ui.confidenceOutput.value = Number(settings.confidence).toFixed(2);
    ui.ttsInput.checked = settings.tts;
  }

  function updateNotificationButton() {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    ui.notifyButton.textContent = permission === 'granted' ? 'NOTIFICATIONS ON' : 'ENABLE NOTIFICATIONS';
    ui.notifyButton.disabled = permission === 'granted' || permission === 'unsupported';
  }

  function initialize() {
    applyTheme();
    wireUI();
    restoreTasks();
    updateNotificationButton();
    ui.wakeValue.textContent = settings.wakeWord.toUpperCase();
    ui.wakePrompt.textContent = `“HEY ${settings.wakeWord.toUpperCase()}”`;
    updateClockAndUptime();
    updateStatus();
    requestAnimationFrame(drawOrb);
    setInterval(updateClockAndUptime, 1000);
    setInterval(renderTasks, 1000);
    // Recovery check: browser engines often end recognition after silence.
    setInterval(() => {
      if (!state.desired) return;
      if (state.recognitionState === 'idle') scheduleRecognitionStart(250);
      if (!state.stream && !state.micPromise) ensureMicrophone();
    }, 5000);
    if ('speechSynthesis' in window) {
      populateVoices();
      speechSynthesis.addEventListener?.('voiceschanged', populateVoices);
    }
    setTimeout(checkMusicBridge, 500);
    if (!SpeechRecognition) {
      ui.permissionOverlay.hidden = true;
      addLog('system', 'Please use Chrome or Edge for full voice features. Typed commands still work.');
    } else startAssistant(); // Auto-request permission on page load.
  }

  initialize();
})();
