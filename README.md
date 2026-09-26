# J.A.R.V.I.S. browser assistant

A single-page voice assistant made with plain HTML, CSS, and JavaScript. Jarvis speaks its replies using your browser's voice. The app has no built-in music player; a small included browser extension controls a separate YouTube Music tab.

## Run locally

1. Open a terminal in this folder.
2. Run `python3 -m http.server 8000`.
3. Open `http://localhost:8000` in Chrome, Edge, or Brave. For YouTube Music controls, use the same browser where you install the extension below. The Codex in-app browser cannot load that extension.
4. Allow microphone access. If the browser blocked the first prompt, click **Enable microphone** after fixing the site's microphone permission.
5. Say **“Hey Jarvis, what time is it”**, or type `what time is it` in the command box.

Click **TEST VOICE** to hear a sample reply. Spoken responses are on by default; the gear button lets you choose a voice or turn replies off. Browser speech output may require an initial click before sound plays. Turn up your device volume if the voice test is silent.

You can also open `index.html` directly in Chrome, Edge, or Brave, but microphone access is more reliable on localhost. Direct file access requires a separate extension permission for music control.

Use HTTPS when hosting the files elsewhere. Microphone access is restricted to secure contexts such as HTTPS and localhost. Speech recognition has limited browser support; text commands remain available where `SpeechRecognition` is absent. The app runs without a backend, but some browsers send speech audio to an online recognition service. Weather requests go directly from your browser to OpenWeatherMap. [Web Speech support](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition), [microphone security](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

## YouTube Music setup

1. Unzip the download so the `extension` folder remains inside `jarvis-assistant`.
2. In Chrome, open `chrome://extensions` (Edge: `edge://extensions`; Brave: `brave://extensions`). Turn on **Developer mode** and choose **Load unpacked**. Select the included `extension` folder.
3. If you open Jarvis by double-clicking `index.html` (`file://`), turn on **Allow access to file URLs** in the extension's details. This extra switch is unnecessary when you use the localhost address above.
4. Open Jarvis and [YouTube Music](https://music.youtube.com/) in tabs of that **same browser**. Start a song in YouTube Music once.
5. Reload Jarvis and click **CHECK LINK**. It should say **YOUTUBE MUSIC CONNECTED**. Then say “Hey Jarvis, pause,” “Hey Jarvis, play,” or “Hey Jarvis, skip.”

The extension controls a YouTube Music **browser tab**, including play, pause, next, previous, volume, and mute. It does not control a desktop music app or another browser. If CHECK LINK says **OPEN YOUTUBE MUSIC**, open the tab; if it says **CHOOSE A SONG**, start a song there. If it says **EXTENSION NOT CONNECTED**, check that both tabs are in the browser with the extension, reload Jarvis, and check file URL access when using a direct file link. YouTube Music may change its page controls over time; reload its tab if a button is not found.

The extension is necessary because a regular webpage cannot operate another tab's media player. The included extension uses Chrome's [host permission and script injection](https://developer.chrome.com/docs/extensions/reference/api/scripting) for YouTube Music; [file URL access](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) needs a separate manual switch. No YouTube password or audio data is sent to Jarvis.

## Commands

Spoken commands must begin with the configured wake word, optionally preceded by “Hey”. Examples below assume **Jarvis**. Typed commands work with or without it.

| Category | Say after “Jarvis” | Behavior |
| --- | --- | --- |
| Listening | `stop listening` | Stops the mic until the toggle is clicked again. |
| Conversation | `hello`, `hi`, `what's your name` | Short replies. |
| Time and date | `what time is it`, `what's the time`, `what's the date`, `what day is it` | Uses your device's local clock. |
| Search | `search Google for black holes`, `search YouTube for jazz`, `Wikipedia Ada Lovelace` | Opens a new tab and adds a backup link to the chat. |
| Weather | `what's the weather in Manila` | Uses the API key saved in Settings. |
| Music | `play`, `pause`, `stop music`, `skip`, `next track`, `previous song` | Controls the open YouTube Music tab through the extension. “Stop music” pauses it. |
| Music volume | `volume up`, `volume down`, `mute`, `unmute` | Adjusts YouTube Music's tab audio. |
| Timer | `set a timer for 5 minutes` | Adds an alert to the Upcoming Alerts panel. Supports seconds, minutes, and hours, up to 24 hours. |
| Reminder | `remind me to stretch in 10 minutes` | Adds a named alert. |
| Websites | `open YouTube`, `open Gmail`, `open github.com`, `open example.com` | Opens a site; unknown names become a Google search. |
| Math | `what is 25 times 4`, `calculate 12 divided by 3` | Safely evaluates one arithmetic operation. Also supports plus and minus. |
| Browser | `go fullscreen`, `exit fullscreen`, `dark mode`, `light mode` | Changes the display. Browsers may require a click for fullscreen. |
| Fun | `tell me a joke`, `flip a coin`, `roll a dice` | Random replies. |

For browser notifications, click **Enable notifications** in Upcoming Alerts. A timer also plays two short beeps when browser audio is available. Alerts and timers persist across reloads, but they require the page to be open to fire; if the page was suspended, overdue alerts fire when it resumes. A closed page cannot deliver browser notifications without a service worker and push infrastructure.

## Listening and recovery

The app keeps one `SpeechRecognition` instance with `continuous = true` and `interimResults = true`. An `onend` event schedules a restart after at least 250 ms. Specific errors use these delays: no speech 300 ms, audio capture 3 s, permission denied 5 s, network 1 s, aborted immediately, and service denied 2 s. A 5-second check catches an idle recognizer, and returning to the tab restarts the session. Start calls are guarded to avoid overlapping recognizers and `InvalidStateError` loops. The retry delays and check interval are near `scheduleRecognitionStart`, `recognition.onerror`, and `initialize` in `app.js`.

The app requests a microphone stream with echo cancellation, noise suppression, and automatic gain control. It samples three seconds of ambient audio to set a baseline for the reactive orb and shows the live microphone level. If the browser supports `SpeechRecognition.start(audioTrack)`, the recognizer uses the processed track; otherwise it uses its built-in microphone source. Commands are gated by a wake word. Identical final transcripts within 1.5 seconds are ignored. Speech output never deliberately stops recognition; recognized phrases heard while Jarvis speaks are ignored to reduce feedback. The confidence threshold labels low-confidence background phrases without the wake word; it does not block commands with a wake word. A phrase containing the wake word is accepted even below the threshold, as specified.

The main toggle is the manual stop control. The requested **“stop listening”** command is also an intentional stop action. No recovery timer restarts listening after either stop action. The recovery counter in Session Uptime increments each time the recognizer starts again.

### Verify it yourself

1. Leave **Always Listening: ON** and speak unrelated words or play background audio. The log should mark recognized phrases without the wake word as ignored.
2. Say **“Hey Jarvis, what time is it.”** A reply should appear in the chat while listening remains ON.
3. Leave the app open through a quiet period, switch tabs, then return. The mic status should return to **CONNECTED**, and the recovery counter should rise when the speech engine has ended or restarted.
4. Click the listening toggle. It should show **OFF** and **STOPPED**, and the recovery counter should not rise while it is off. Click again to resume.

This verifies the recovery logic during a real session; it cannot prove literal, uninterrupted listening forever. Browsers and operating systems can suspend background tabs, close pages, revoke permission, or block speech services. When access is unavailable, the app keeps retrying and shows its actual connection state. Some browsers may also stop recognition when speech synthesis takes audio focus; the restart loop recovers where allowed. Popup blockers can prevent voice-triggered new tabs, so search and site commands include a clickable link.

## Customize

Use the gear button to change the wake word, speech voice, confidence threshold, spoken replies, and OpenWeatherMap API key. Settings and alert times are stored in `localStorage` for this browser origin. The API key is visible to anyone with access to this browser profile, so use a key intended for client-side use. To add a command, add a `{patterns: [...], handler: (match, transcript) => ...}` entry to the `commands` object in `app.js`. A handler can return a string or `{text, link, linkLabel}` and may be asynchronous.

Weather uses OpenWeatherMap's [Geocoding API](https://openweathermap.org/api/geocoding-api) followed by [Current Weather API](https://openweathermap.org/api/current), because weather lookups by city name on the Current Weather endpoint are deprecated.
