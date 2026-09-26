(() => {
  'use strict';

  // All browser state lives here. The recognizer itself is created once and reused.
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'app','liveClock','settingsButton','modeStatus','detailStatus','interimTranscript',
    'orbCanvas','orbLevel','listeningToggle','toggleLabel','toggleHint','wakePrompt',
    'micState','noiseMeter','noiseMeterFill','noiseNote','noiseValue','wakeValue',
    'uptime','restartCount','musicPlayer','trackTitle','trackSubtitle','previousTrack',
    'playPause','nextTrack','chatList','chatEmpty','clearLog','textForm','textCommand',
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
    level: 0, isSpeaking: false, currentSpeech: null, processing: false, lastTranscript: '', lastTranscriptAt: 0,
    commandQueue: Promise.resolve(), tasks: [], taskTimeouts: new Map(),
    trackIndex: 0, trackURLs: new Map(), ignoreMicPrompt: false
  };

  // These short loops are generated as WAV blobs, so the music player needs no download.
  const tracks = [
    {title: 'Orbit Drift', notes: [220, 277.18, 329.63, 277.18, 246.94, 293.66, 369.99, 293.66], bass: 110},
    {title: 'Neon Horizon', notes: [261.63, 329.63, 392, 329.63, 293.66, 349.23, 440, 349.23], bass: 130.81},
    {title: 'Starlight Protocol', notes: [196, 246.94, 293.66, 246.94, 174.61, 220, 261.63, 220], bass: 98}
  ];

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
    ui.listeningToggle.setAttribute('aria-pressed', String(state.desired));
    ui.toggleLabel.textContent = `Always Listening: ${state.desired ? 'ON' : 'OFF'}`;
    ui.toggleHint.textContent = state.desired ? 'Click to stop the assistant' : 'Click to resume listening';
    if (!SpeechRecognition) {
      ui.modeStatus.textContent = 'VOICE RECOGNITION UNAVAILABLE';
      ui.detailStatus.textContent = 'Please use Chrome or Edge for full voice features. Text commands still work.';
      ui.micState.textContent = 'UNSUPPORTED';
      ui.app.dataset.state = 'idle';
      return;
    }
    if (!state.desired) {
      ui.modeStatus.textContent = 'VOICE INTERFACE STANDBY';
      ui.detailStatus.textContent = 'Listening stopped. Text commands remain available.';
      ui.micState.textContent = 'STOPPED';
      ui.app.dataset.state = 'idle';
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
    state.currentSpeech = null;
    state.isSpeaking = false;
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
    addLog('user', transcript, {ignored: duplicate || !wake || state.isSpeaking});
    if (duplicate) { addLog('system', 'Duplicate phrase ignored.', {ignored: true}); return; }
    if (state.isSpeaking) { addLog('system', 'Ignored while Jarvis was speaking.', {ignored: true}); return; }
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
  }

  function selectedVoice() {
    const voices = speechSynthesis.getVoices();
    return voices.find((voice) => voice.voiceURI === settings.voiceURI) ||
      voices.find((voice) => /en[-_]gb/i.test(voice.lang) && /male|daniel|oliver|arthur|george/i.test(voice.name)) ||
      voices.find((voice) => /en[-_]gb/i.test(voice.lang)) ||
      voices.find((voice) => /^en/i.test(voice.lang));
  }

  function speak(message) {
    if (!settings.tts || !('speechSynthesis' in window)) { updateStatus(); return; }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    state.currentSpeech = utterance;
    utterance.voice = selectedVoice() || null;
    utterance.lang = utterance.voice?.lang || 'en-GB';
    utterance.rate = 1.02;
    utterance.pitch = 0.92;
    utterance.onstart = () => { if (state.currentSpeech === utterance) { state.isSpeaking = true; updateStatus(); } };
    utterance.onend = utterance.onerror = () => {
      if (state.currentSpeech === utterance) { state.currentSpeech = null; state.isSpeaking = false; updateStatus(); }
    };
    try { speechSynthesis.speak(utterance); }
    catch { state.currentSpeech = null; state.isSpeaking = false; updateStatus(); }
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
    const task = {id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, type, label, due: Date.now() + delay};
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
    playMusic: {patterns: [/^(?:play music|resume music|play song)\b/i], handler: async () => {
      const played = await playMusic();
      return played ? 'Right away, sir. Playing music.' : 'Press play in the music player to allow audio in this browser.';
    }},
    pauseMusic: {patterns: [/^(?:pause(?: music)?|pause song)\b/i], handler: () => { ui.musicPlayer.pause(); return 'Music paused.'; }},
    stopMusic: {patterns: [/^stop music\b/i], handler: () => { ui.musicPlayer.pause(); ui.musicPlayer.currentTime = 0; return 'Music stopped.'; }},
    nextTrack: {patterns: [/^(?:skip song|next track|next song)\b/i], handler: async () => {
      const played = await selectTrack(state.trackIndex + 1, true);
      return played ? `Playing ${tracks[state.trackIndex].title}.` : `${tracks[state.trackIndex].title} is selected. Press play to allow audio.`;
    }},
    previousTrack: {patterns: [/^(?:previous song|previous track|last song)\b/i], handler: async () => {
      const played = await selectTrack(state.trackIndex - 1, true);
      return played ? `Playing ${tracks[state.trackIndex].title}.` : `${tracks[state.trackIndex].title} is selected. Press play to allow audio.`;
    }},
    volumeUp: {patterns: [/^volume up\b/i], handler: () => { ui.musicPlayer.muted = false; ui.musicPlayer.volume = Math.min(1, ui.musicPlayer.volume + 0.15); return `Volume ${Math.round(ui.musicPlayer.volume * 100)} percent.`; }},
    volumeDown: {patterns: [/^volume down\b/i], handler: () => { ui.musicPlayer.volume = Math.max(0, ui.musicPlayer.volume - 0.15); return `Volume ${Math.round(ui.musicPlayer.volume * 100)} percent.`; }},
    mute: {patterns: [/^mute\b/i], handler: () => { ui.musicPlayer.muted = true; return 'Music muted.'; }},
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

  function makeTrackURL(index) {
    // Synthesize a short PCM WAV and cache its blob URL for replay/track changes.
    if (state.trackURLs.has(index)) return state.trackURLs.get(index);
    const sampleRate = 16000, seconds = 8, count = sampleRate * seconds;
    const data = new ArrayBuffer(44 + count * 2), view = new DataView(data);
    const writeText = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    writeText(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); writeText(8, 'WAVE'); writeText(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeText(36, 'data'); view.setUint32(40, count * 2, true);
    const track = tracks[index];
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate, beat = Math.floor(t * 2), phase = (t * 2) % 1;
      const note = track.notes[beat % track.notes.length];
      const envelope = Math.min(1, phase * 26) * Math.exp(-phase * 2.7);
      const lead = (Math.sin(2 * Math.PI * note * t) + 0.2 * Math.sin(2 * Math.PI * note * 2 * t)) * envelope * 0.23;
      const bass = Math.sin(2 * Math.PI * track.bass * t) * 0.15;
      const kickPhase = t % 0.5;
      const kick = Math.sin(2 * Math.PI * (65 - 30 * kickPhase) * kickPhase) * Math.exp(-kickPhase * 25) * 0.19;
      const fade = Math.min(1, t * 4, (seconds - t) * 4);
      const sample = Math.max(-1, Math.min(1, (lead + bass + kick) * fade));
      view.setInt16(44 + i * 2, sample * 32767, true);
    }
    const url = URL.createObjectURL(new Blob([data], {type: 'audio/wav'}));
    state.trackURLs.set(index, url);
    return url;
  }

  async function selectTrack(index, autoplay = false) {
    state.trackIndex = (index + tracks.length) % tracks.length;
    const track = tracks[state.trackIndex];
    ui.trackTitle.textContent = track.title;
    ui.trackSubtitle.textContent = `Built-in ambient playlist · ${state.trackIndex + 1} / ${tracks.length}`;
    ui.musicPlayer.src = makeTrackURL(state.trackIndex);
    ui.musicPlayer.load();
    if (autoplay) return playMusic();
    return true;
  }

  async function playMusic() {
    if (!ui.musicPlayer.src) await selectTrack(state.trackIndex);
    try { await ui.musicPlayer.play(); return true; } catch { return false; }
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
    ui.listeningToggle.addEventListener('click', () => { unlockAudio(); state.desired ? stopAssistant() : startAssistant(); });
    ui.grantMicButton.addEventListener('click', () => { unlockAudio(); startAssistant(); });
    ui.continueWithoutMic.addEventListener('click', () => { unlockAudio(); stopAssistant(); ui.permissionOverlay.hidden = true; });
    ui.settingsButton.addEventListener('click', () => { fillSettings(); ui.settingsDialog.showModal(); });
    ui.closeSettings.addEventListener('click', () => ui.settingsDialog.close());
    ui.confidenceInput.addEventListener('input', () => { ui.confidenceOutput.value = Number(ui.confidenceInput.value).toFixed(2); });
    ui.settingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      settings = {...settings, wakeWord: normalize(ui.wakeWordInput.value) || 'Jarvis', weatherKey: ui.weatherKeyInput.value.trim(), voiceURI: ui.voiceSelect.value, confidence: Number(ui.confidenceInput.value), tts: ui.ttsInput.checked};
      if (!settings.tts && 'speechSynthesis' in window) { speechSynthesis.cancel(); state.currentSpeech = null; state.isSpeaking = false; }
      saveStored(SETTINGS_KEY, settings);
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
    ui.previousTrack.addEventListener('click', () => selectTrack(state.trackIndex - 1, !ui.musicPlayer.paused));
    ui.nextTrack.addEventListener('click', () => selectTrack(state.trackIndex + 1, !ui.musicPlayer.paused));
    ui.playPause.addEventListener('click', () => ui.musicPlayer.paused ? playMusic() : ui.musicPlayer.pause());
    ui.musicPlayer.addEventListener('play', () => { ui.playPause.textContent = 'Ⅱ'; ui.playPause.setAttribute('aria-label', 'Pause music'); });
    ui.musicPlayer.addEventListener('pause', () => { ui.playPause.textContent = '▶'; ui.playPause.setAttribute('aria-label', 'Play music'); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.desired) {
        ensureMicrophone();
        if (state.recognitionState === 'listening') {
          try { state.recognition.abort(); } catch { scheduleRecognitionStart(250); }
        } else scheduleRecognitionStart(250);
      }
      if (!document.hidden) state.tasks.filter((task) => task.due <= Date.now()).forEach((task) => fireTask(task.id));
    });
    window.addEventListener('beforeunload', () => state.trackURLs.forEach((url) => URL.revokeObjectURL(url)));
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
    if (!SpeechRecognition) {
      ui.permissionOverlay.hidden = true;
      addLog('system', 'Please use Chrome or Edge for full voice features. Typed commands still work.');
    } else startAssistant(); // Auto-request permission on page load.
  }

  initialize();
})();
