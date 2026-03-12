// --------------------------- Tunables ---------------------------
const SILENCE_GAP_MS = 500;   // was 1200 - end segment after ~0.5s silence
const MIN_SEG_MS = 600;   // was 1200 - keep short phrases
const REC_SLICE_MS = 300;   // was 1000 - finer recorder granularity
const RMS_THRESH = 0.02;  // unchanged - VAD threshold (tune per mic/room)
const VAD_POLL_MS = 100;   // unchanged - VAD polling cadence
const MAX_SEG_MS = 8000;  // flush a segment after ~8s even without silence


const HAS_MEDIA_RECORDER = typeof MediaRecorder !== 'undefined';
// Pick a stable MIME; fall back progressively.
const MIME = (HAS_MEDIA_RECORDER && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
	: HAS_MEDIA_RECORDER && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
		: '');

// Inject minimal CSS for speaking state (button goes red on voice)
function ensureSpeakingStyle() {
	if (document.getElementById('scribe-style')) return;
	const style = document.createElement('style');
	style.id = 'scribe-style';
	style.textContent = `
	.scribe-btn.speaking {
		background-color: #dc3545; /* red */
		border-color: #dc3545;
		color: #fff;
		transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
	}

	/* WhatsApp-like inline recording pill */
	.scribe-vis {
		display: none;
		align-items: center;
		gap: .5rem;
		margin-left: .5rem;
		padding: .25rem .5rem;
		border-radius: 999px;
		background: var(--scribe-pill-bg, rgba(9, 30, 66, 0.06));
		border: 1px solid rgba(9, 30, 66, 0.08);
		box-shadow: 0 1px 2px rgba(0,0,0,.06);
		-webkit-font-smoothing: antialiased;
		font-synthesis-weight: none;
	}

	@media (prefers-color-scheme: dark) {
		.scribe-vis {
			background: rgba(255,255,255,0.06);
			border-color: rgba(255,255,255,0.12);
			box-shadow: 0 1px 2px rgba(0,0,0,.35);
		}
	}

	.scribe-vis.is-active { display: inline-flex; }

	/* Pulsing red dot like WhatsApp while recording */
	.scribe-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #ff3b30;
		box-shadow: 0 0 0 0 rgba(255,59,48,.6);
		animation: scribe-pulse 1.3s infinite;
	}
	@keyframes scribe-pulse {
		0%   { box-shadow: 0 0 0 0 rgba(255,59,48,.6); }
		70%  { box-shadow: 0 0 0 8px rgba(255,59,48,0); }
		100% { box-shadow: 0 0 0 0 rgba(255,59,48,0); }
	}

	/* Timer text */
	.scribe-time {
		min-width: 38px;
		text-align: right;
		font: 600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
		letter-spacing: .2px;
		color: #0f5132;
		opacity: .9;
	}
	@media (prefers-color-scheme: dark) {
		.scribe-time { color: #d1fae5; opacity: .95; }
	}

	/* Waveform canvas */
	.scribe-wave {
		display: block;
		width: 200px;
		height: 28px;
		background: transparent;
		border: 0;
		border-radius: 6px;
	}

	/* Subtle vertical VU bar (kept for continuity) */
	.scribe-vu {
		width: 6px;
		height: 18px;
		border-radius: 3px;
		background: #e9ecef;
		position: relative;
		overflow: hidden;
	}
	.scribe-vu > i {
		position: absolute;
		bottom: 0; left: 0; right: 0;
		height: 0%;
		background: #25d366; /* WhatsApp green */
		transition: height 80ms linear;
	}
	@media (prefers-color-scheme: dark) {
		.scribe-vu { background: rgba(255,255,255,.12); }
	}
	`;
	document.head.appendChild(style);
}
// Render inline microphone feedback using the shared analyser without altering recorder flow.
// Render inline microphone feedback using the shared analyser without altering recorder flow.
function makeVisualizer(btnEl) {
	const vis = document.createElement('span'); vis.className = 'scribe-vis';
	const dot = document.createElement('span'); dot.className = 'scribe-dot';
	const time = document.createElement('span'); time.className = 'scribe-time'; time.textContent = '0:00';
	const cv = document.createElement('canvas'); cv.className = 'scribe-wave';

	vis.appendChild(dot);
	vis.appendChild(time);
	vis.appendChild(cv);

	if (btnEl && btnEl.parentNode) {
		btnEl.parentNode.insertBefore(vis, btnEl.nextSibling);
	}

	vis.setAttribute('aria-hidden', 'true');

	// Keep the canvas bitmap aligned with the rendered size so the waveform stays crisp on HiDPI screens.
	function fitCanvas() {
		const cssW = Math.max(1, cv.clientWidth || 200);
		const cssH = Math.max(1, cv.clientHeight || 28);
		const dpr = Math.max(1, window.devicePixelRatio || 1);
		const wantW = Math.round(cssW * dpr);
		const wantH = Math.round(cssH * dpr);
		if (cv.width !== wantW || cv.height !== wantH) {
			cv.width = wantW;
			cv.height = wantH;
		}
		return { dpr, cssW, cssH };
	}

	const api = {
		analyser: null,
		_raf: null,
		_ctx: null,
		_buf: null, // <-- CORRECT (from buffer fix)
		_grad: null,
		_lastW: 0,
		_lastH: 0,
		_t0: 0,
		_noiseFloor: 0,

		// --- MODIFICATION: Replaced _lastAmp with an array ---
		_ampHistory: [],

		// Toggle the inline container so the UI only shows feedback while actively recording.
		_ensureVisible() {
			vis.classList.add('is-active');
			vis.style.display = '';
			vis.setAttribute('aria-hidden', 'false');
		},
		_hide() {
			vis.classList.remove('is-active');
			vis.style.display = 'none';
			vis.setAttribute('aria-hidden', 'true');
		},
		_formatTime(ms) {
			const s = Math.max(0, Math.floor(ms / 1000));
			const m = Math.floor(s / 60);
			const rem = s % 60;
			return `${m}:${rem < 10 ? '0' : ''}${rem}`;
		},
		_updateGradient(cssW, cssH) {
			// Not really a gradient anymore; keep hook but force pure black.
			this._grad = '#000000';
			this._lastW = cssW;
			this._lastH = cssH;
		},
		attachAnalyser(analyser) {
			this.analyser = analyser;

			if (this.analyser) {
				this._buf = new Float32Array(this.analyser.fftSize); // <-- CORRECT (from buffer fix)
			}

			if (!this._ctx) {
				this._ctx = cv.getContext('2d');
				if (this._ctx) {
					this._ctx.lineJoin = 'round';
					this._ctx.lineCap = 'round';
				}
			}
		},
		start() {
			if (this._raf) return;
			if (!this._ctx) {
				this._ctx = cv.getContext('2d');
				if (this._ctx) {
					this._ctx.lineJoin = 'round';
					this._ctx.lineCap = 'round';
				}
			}

			const ctx = this._ctx;
			const buf = this._buf;
			if (!ctx || !buf) return; // <-- CORRECT (from buffer fix)

			this._ensureVisible();
			this._t0 = performance.now();
			this._noiseFloor = 0;

			// --- MODIFICATION: Clear history array ---
			this._ampHistory = [];

			// ===================================================================
			// --- MODIFICATION: This entire 'draw' function is rewritten ---
			// ===================================================================
			const draw = () => {
				this._raf = requestAnimationFrame(draw);
				if (!this.analyser || !ctx || !buf) return;

				// --- 1. GET RMS (Same as before) ---
				this.analyser.getFloatTimeDomainData(buf);
				let sum = 0;
				for (let i = 0; i < buf.length; i++) {
					const value = buf[i];
					sum += value * value;
				}
				const rms = Math.sqrt(sum / buf.length);

				// --- 2. GET NORMALIZED AMP (Same as before) ---
				if (this._noiseFloor === 0) {
					this._noiseFloor = rms;
				} else {
					const isQuieter = rms <= this._noiseFloor;
					const alpha = isQuieter ? 0.05 : 0.002;
					this._noiseFloor = this._noiseFloor * (1 - alpha) + rms * alpha;
				}

				const floor = this._noiseFloor;
				// You can tune this: 0.05 = hotter, 0.2 = calmer
				const DYNAMIC_RANGE = 0.1;
				let span = DYNAMIC_RANGE;

				let ampNorm = (rms - floor) / span;
				if (ampNorm < 0) ampNorm = 0;
				if (ampNorm > 1) ampNorm = 1;

				// --- 3. UPDATE TIMER (Same as before) ---
				const tMs = performance.now() - this._t0;
				time.textContent = this._formatTime(tMs);

				// --- 4. GET CANVAS SIZE (Same as before) ---
				const dims = fitCanvas();
				const dpr = dims.dpr;
				// const cssW = dims.cssW; // No longer needed
				// const cssH = dims.cssH; // No longer needed
				const widthPx = cv.width;
				const heightPx = cv.height;

				this._updateGradient(0, 0); // (Not really used but keep for _grad)

				// --- 5. UPDATE HISTORY (New Logic) ---
				// Add new raw amp value to our history
				this._ampHistory.push(ampNorm);

				// Define bar appearance (in pixels)
				const barWidth = 2 * dpr;
				const barSpacing = 1 * dpr;
				const barStep = barWidth + barSpacing;

				// How many bars fit on screen?
				const maxBars = Math.floor(widthPx / barStep);

				// Prune old history from the left (shifting)
				while (this._ampHistory.length > maxBars) {
					this._ampHistory.shift();
				}

				// --- 6. REDRAW ENTIRE CANVAS (New Logic) ---
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				// Clear THE ENTIRE CANVAS
				ctx.clearRect(0, 0, widthPx, heightPx);

				ctx.fillStyle = this._grad || '#000000';

				const minFrac = 0.03; // 3% min height
				const centerY = heightPx / 2;

				// Iterate backwards from the right edge
				let x = widthPx - barWidth;
				for (let i = this._ampHistory.length - 1; i >= 0; i--) {
					if (x < 0) break; // Stop if we run off the left edge

					// Get the raw, stored amplitude
					const amp = this._ampHistory[i];

					const barFrac = minFrac + (1 - minFrac) * amp;
					const barHeight = Math.max(dpr, Math.round(heightPx * barFrac)); // Min height of 1px (or dpr)
					const barY = Math.round(centerY - barHeight / 2);

					ctx.fillRect(x, barY, barWidth, barHeight);

					x -= barStep; // Move left
				}
			};

			this._raf = requestAnimationFrame(draw);
		},
		stop() {
			if (this._raf) {
				cancelAnimationFrame(this._raf);
				this._raf = null;
			}
			if (this._ctx) {
				fitCanvas();
				this._ctx.setTransform(1, 0, 0, 1, 0, 0);
				this._ctx.clearRect(0, 0, cv.width, cv.height);
			}
			time.textContent = '0:00';
			this._hide();

			// --- MODIFICATION: Clear history ---
			this._ampHistory = [];
		},
		clear() {
			if (!this._ctx) {
				this._ctx = cv.getContext('2d');
			}
			const ctx = this._ctx;
			if (ctx) {
				fitCanvas();
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.clearRect(0, 0, cv.width, cv.height);
			}
			time.textContent = '0:00';
			this._hide();

			// --- MODIFICATION: Clear history ---
			this._ampHistory = [];
		}
	};

	return api;
}

// Provide a user-facing hint when the microphone cannot be accessed.
function showMicrophoneErrorGuidance(err, btn) {
	if (!err) return;

	const name = (err.name || '').toLowerCase();
	const isPermissionError = name === 'notallowederror' || name === 'permissiondeniederror';
	let message = null;

	if (isPermissionError) {
		const insecure = window && window.location && window.location.protocol !== 'https:';
		message = insecure
			? 'Microphone access requires a secure (HTTPS) connection. Open this page over HTTPS, allow microphone permissions, and then reload.'
			: 'Microphone access was blocked. Click the lock icon in your browser\'s address bar, allow microphone permissions for this site, and then reload the page.';
	}

	if (!message) {
		return;
	}

	try {
		if (window.UserMessages && typeof window.UserMessages.DisplayNow === 'function') {
			window.UserMessages.DisplayNow(message, 'Warning');
		} else if (window.UserMessages && typeof window.UserMessages.Display === 'function') {
			window.UserMessages.Display(message, 'Warning');
		} else if (typeof window.alert === 'function') {
			window.alert(message);
		}
	} catch (_) {
		/* no-op: UI messaging is best-effort */
	}

	if (btn) {
		try {
			btn.setAttribute('title', message);
			btn.setAttribute('data-bs-original-title', message);
		} catch (_) {
			/* ignore tooltip assignment errors */
		}
	}
}

window.initScribe = function (btnEl, textEl) {
	ensureSpeakingStyle();

	const btn = typeof btnEl === 'string' ? document.getElementById(btnEl) : btnEl;
	const el = typeof textEl === 'string' ? document.getElementById(textEl) : textEl;
	if (!btn || !el) return;
	btn.classList.add('scribe-btn');


	const Visualizer = makeVisualizer(btn);

	// --------------------------- Queue Recorder (with optional archive) ---------------------------
	const SegmentedRecorder = (() => {
		let stream = null;
		let audioCtx = null, analyser = null, src = null, vadTimer = null;

		// Per-segment recorder (created only while capturing)
		let rec = null;
		let recChunks = [];
		let isCapturing = false;

		// Optional full-session recorder (runs the whole time)
		let fullRec = null;
		let fullChunks = [];
		let archiveEnabled = false;			// opt-in flag
		let archiveBlob = null;					// final blob after stop
		let archiveWaiters = [];				// promises waiting for the archive

		// VAD state
		let lastSpeechTs = 0;
		let segStartTs = 0;
		let silenceMs = 0;

		// Queue for incremental segments
		const queue = [];
		const waiters = [];

		// Lifecycle flags
		let active = false;
		let stopping = false;
		let closed = false;

		function now() { return performance.now(); }

		// PUBLIC: enable/disable archive; can be called before or during a session.
		function enableArchive(flag) {
			const want = !!flag;
			if (archiveEnabled === want) return;
			archiveEnabled = want;

			// If we're already running, start/stop the full recorder accordingly.
			if (active) {
				if (archiveEnabled && !fullRec) startFullRecorder();
				if (!archiveEnabled && fullRec) stopFullRecorder(/* finalize */ false);
			}
		}

		// PUBLIC: await the final full-session Blob (or null if not enabled or nothing recorded).
		async function getArchive() {
			if (archiveBlob || (!archiveEnabled && !fullRec)) return archiveBlob || null;
			return new Promise(resolve => archiveWaiters.push(resolve));
		}

		async function start() {
			if (active) return;
			if (!HAS_MEDIA_RECORDER) {
				throw new Error('MediaRecorder is not supported in this browser.');
			}

			stream = await navigator.mediaDevices.getUserMedia({ audio: true });

			// Web Audio analyser for VAD (drives segmentation)
			audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			try { if (audioCtx.state === 'suspended') await audioCtx.resume(); } catch { }
			analyser = audioCtx.createAnalyser(); analyser.fftSize = 2048;
			src = audioCtx.createMediaStreamSource(stream); src.connect(analyser);

			// Synchronize the visualizer with the analyser lifecycle so UI reflects live input.
			Visualizer.attachAnalyser(analyser);
			Visualizer.start();

			// Reset state
			rec = null; recChunks = []; isCapturing = false;
			fullRec = null; fullChunks = []; archiveBlob = null;
			lastSpeechTs = 0; segStartTs = 0; silenceMs = 0;
			stopping = false; closed = false;

			// Start archive recorder if requested
			if (archiveEnabled) startFullRecorder();

			// VAD loop (unchanged chunking logic)
			const buf = new Float32Array(analyser.fftSize);
			vadTimer = setInterval(() => {
				if (!analyser) return;
				analyser.getFloatTimeDomainData(buf);
				let sum = 0; for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; }
				const rms = Math.sqrt(sum / buf.length);
				const t = now();

				// Hard cap segment length so long dictations stream in smaller chunks
				if (isCapturing) {
					const segAge = t - segStartTs;
					if (segAge >= MAX_SEG_MS) {
						isCapturing = false;
						endSegment();
						silenceMs = 0;
					}
				}

				if (rms >= RMS_THRESH) {
					// voice
					lastSpeechTs = t;
					silenceMs = 0;
					if (!isCapturing) beginSegment(t);
					btn.classList.add('speaking');
				} else {
					// silence
					if (isCapturing) {
						silenceMs += VAD_POLL_MS;
						const voicedMs = Math.max(0, lastSpeechTs - segStartTs);
						if (silenceMs >= SILENCE_GAP_MS && voicedMs >= MIN_SEG_MS) {
							isCapturing = false;
							endSegment();                             // finalize on rec.onstop
							silenceMs = 0;
						}
					}
					btn.classList.remove('speaking');
				}
			}, VAD_POLL_MS);


			active = true;
		}

		function beginSegment(tNow) {
			rec = MIME ? new MediaRecorder(stream, { mimeType: MIME }) : new MediaRecorder(stream);
			recChunks = [];
			segStartTs = tNow;
			isCapturing = true;

			rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
			rec.onstop = finalizeSegment;
			rec.start(REC_SLICE_MS);
		}

		function endSegment() {
			try { rec && rec.state !== 'inactive' && rec.stop(); } catch { }
		}

		function finalizeSegment() {
			const voicedMs = Math.max(0, lastSpeechTs - segStartTs);
			if (voicedMs >= MIN_SEG_MS && recChunks.length) {
				const keep = Math.max(1, Math.min(recChunks.length, Math.ceil(voicedMs / REC_SLICE_MS)));
				const blob = new Blob(recChunks.slice(0, keep), { type: recChunks[0]?.type || MIME || 'audio/webm' });
				if (waiters.length) waiters.shift()(blob);
				else queue.push(blob);
			}
			recChunks = [];
			rec = null;

			// If stop() already requested, we may close after the last segment
			if (stopping) maybeClose();
		}

		// ---- Full-session recorder control (independent of chunking) ----
		function startFullRecorder() {
			fullRec = MIME ? new MediaRecorder(stream, { mimeType: MIME }) : new MediaRecorder(stream);
			fullChunks = [];
			fullRec.ondataavailable = (e) => { if (e.data && e.data.size) fullChunks.push(e.data); };
			fullRec.onstop = () => {
				archiveBlob = fullChunks.length
					? new Blob(fullChunks, { type: fullChunks[0]?.type || MIME || 'audio/webm' })
					: null;
				fullChunks = [];
				// Resolve waiters
				while (archiveWaiters.length) { try { archiveWaiters.shift()(archiveBlob); } catch { } }
				// If we were stopping and segments are done, close queue
				if (stopping) maybeClose();
			};
			fullRec.start(REC_SLICE_MS);
		}

		function stopFullRecorder(finalize = true) {
			if (!fullRec) return;
			try {
				if (finalize && fullRec.state !== 'inactive') fullRec.stop();
				if (!finalize) { // discard and reset
					fullRec.ondataavailable = null;
					fullRec.onstop = null;
				}
			} catch { }
			fullRec = null;
		}

		// Close queue when both: no active segment and (no archive OR archive has stopped)
		function maybeClose() {
			const segmentIdle = !rec && !isCapturing;
			const archiveIdle = !archiveEnabled || !fullRec;
			if (segmentIdle && archiveIdle) closeQueue();
		}

		function closeQueue() {
			if (closed) return;
			closed = true;
			btn.classList.remove('speaking');
			while (waiters.length) { try { waiters.shift()(null); } catch { } }
		}

		function stop() {
			if (!active) return;
			active = false;
			stopping = true;

			// End any active segment (finalization will run)
			if (isCapturing) { isCapturing = false; endSegment(); }

			// Stop archive if enabled
			if (archiveEnabled) stopFullRecorder(/* finalize */ true);

			// Halt the visual feedback when recording ends.
			Visualizer.stop();

			// Tear down VAD and audio
			if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
			try { src && src.disconnect(); } catch { }
			src = null; analyser = null;
			if (audioCtx) { try { audioCtx.close(); } catch { } audioCtx = null; }
			if (stream) { stream.getTracks().forEach(t => { try { t.stop(); } catch { } }); stream = null; }

			// If nothing else is pending, close immediately
			maybeClose();
		}

		async function dequeue() {
			if (queue.length) return queue.shift();
			if (closed) return null;
			return new Promise(resolve => waiters.push(resolve));
		}

		return { start, stop, dequeue, enableArchive, getArchive };
	})();

	window.SegmentedRecorder = SegmentedRecorder;

	// --------------------------- Minimal Sequential Processor ---------------------------
	const SegmentProcessor = (() => {
		let running = false;
		let _done = null; // promise that resolves when current loop finishes

		async function _loop(resolveDone) {
			try {
				for (; ;) {
					const blob = await SegmentedRecorder.dequeue();
					if (!blob) break;             // exit only when the recorder closes the queue
					try {
						const fd = new FormData();
						fd.append('file', blob, `seg_${Date.now()}.webm`);
						const resp = await fetch('/api/transcribe', { method: 'POST', body: fd });
						if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
						const text = await resp.text();

						const sep = el.value && !/\s$/.test(el.value) ? '\n' : '';
						el.value = (el.value || '') + sep + text;
					} catch (err) {
						console.error('transcribe failed:', err);
					}
				}
			} finally {
				resolveDone();          // signal loop completion
			}
		}

		async function start() {
			if (running) return;
			running = true;
			_done = new Promise(res => { _loop(res); });
		}

		// Stop accepting new work, but leave the loop to drain until SegmentedRecorder closes its queue.
		function stop() {
			if (!running) return;
			running = false; // gate re-entry only; loop exits when dequeue() returns null
		}

		// Wait for the loop to finish draining (after SegmentedRecorder.stop()).
		async function flush() {
			if (_done) { try { await _done; } catch { } }
			_done = null;
		}

		async function transcribeFullArchive(blob) {
			if (!blob) return;

			try {
				const fd = new FormData();
				fd.append('file', blob, `full_${Date.now()}.webm`);

				// Reuse the same endpoint as segments.
				// If you ever want special behavior for full runs,
				// you can add a query string like ?mode=full and branch on the server.
				const resp = await fetch('/api/transcribe', {
					method: 'POST',
					body: fd
				});

				if (!resp.ok)
					throw new Error(`Full transcription HTTP ${resp.status}`);

				const text = await resp.text();

				// Replace all incremental text with the holistic result.
				if (text && text.trim()) {
					el.value = text;
				}
			}
			catch (err) {
				console.error('full transcription failed:', err);
				// On failure, we leave the incremental text intact.
			}
		}

		return { start, stop, flush, transcribeFullArchive };
	})();

	// --- Minimal UI wiring ---
	let uiActive = false;
	const IDLE_LABEL = 'Start Recording';
	const RECORDING_LABEL = 'Stop Recording';
	const PROCESSING_LABEL = 'Processing...';

	function buildSpeechButtonMarkup(iconClass, label) {
		const safeIconClass = typeof iconClass === 'string' && iconClass.trim() ? iconClass.trim() : 'bi-mic-fill';
		const safeLabel = typeof label === 'string' && label.trim() ? label.trim() : IDLE_LABEL;
		return `
			<i class="bi ${safeIconClass}" aria-hidden="true"></i>
			<span class="visually-hidden">${safeLabel}</span>
		`;
	}

	function setBtn(label, opts = {}) {
		if (!btn) return;
		const iconClass = opts.busy === true
			? 'bi-hourglass-split'
			: (opts.recording === true ? 'bi-stop-fill' : 'bi-mic-fill');
		btn.innerHTML = buildSpeechButtonMarkup(iconClass, label);
		btn.disabled = !!opts.disabled;
		btn.setAttribute('aria-busy', opts.busy ? 'true' : 'false');
		btn.setAttribute('aria-label', label);
		btn.title = label;
		btn.classList.toggle('mic-recording', opts.recording === true);
		btn.classList.toggle('is-recording', opts.recording === true);
		btn.classList.toggle('is-processing', opts.busy === true);
	}

	function toIdle() {
		uiActive = false;
		setBtn(IDLE_LABEL, { disabled: false, busy: false, recording: false });
		btn.classList.remove('speaking');
		// Reset the visual canvas whenever the control is idle.
		Visualizer.clear();
	}

	function toRecording() {
		uiActive = true;
		setBtn(RECORDING_LABEL, { disabled: false, busy: false, recording: true });
	}

	toIdle();

	btn.onclick = async () => {
		if (!uiActive) {
			try {
				toRecording();
				SegmentedRecorder.enableArchive(true);
				await SegmentedRecorder.start();
				await SegmentProcessor.start();
			} catch (err) {
				console.error('Start failed:', err);
				toIdle();
			}
		} else {
			try {
				setBtn(PROCESSING_LABEL, { disabled: true, busy: true, recording: false });

				// 1) close inputs first (this will cause dequeue() to yield null once segments + archive finish)
				SegmentedRecorder.stop();

				// 2) stop accepting new starts but drain everything already queued
				SegmentProcessor.stop();
				await SegmentProcessor.flush();

				// 3) fetch the archive after all segment blobs were sent
				const archive = await SegmentedRecorder.getArchive();
				window.scribeArchive = archive;

				// 4) run holistic transcription on the full archive and replace text
				if (archive) {
					await SegmentProcessor.transcribeFullArchive(archive);
				}
			} catch (err) {
				console.error('Stop failed:', err);
			} finally {
				toIdle();
			}
		}

	};

	window.addEventListener('beforeunload', () => {
		try { SegmentProcessor.stop(); } catch { }
		try { SegmentedRecorder.stop(); } catch { }
	});
};

(function () {
	function createTinyMceProxy(editorId) {
		return {
			get value() {
				if (window.tinymce) {
					const editor = window.tinymce.get(editorId);
					if (editor) {
						return editor.getContent({ format: 'text' }) || '';
					}
				}

				const fallback = document.getElementById(editorId);
				if (fallback && typeof fallback.value === 'string') {
					return fallback.value;
				}

				return '';
			},
			set value(val) {
				const strValue = typeof val === 'string' ? val : '';

				if (window.tinymce) {
					const editor = window.tinymce.get(editorId);
					if (editor) {
						editor.setContent(strValue);
					}
				}

				const fallback = document.getElementById(editorId);
				if (fallback && typeof fallback.value === 'string') {
					fallback.value = strValue;
				}
			}
		};
	}

	function resolveTarget(btn) {
		if (!btn || !btn.dataset) return null;

		let target = btn.dataset.scribeTarget || '';
		target = target.trim();
		if (!target) return null;

		if (target.toLowerCase().startsWith('tinymce:')) {
			const editorId = target.substring('tinymce:'.length).trim();
			if (!editorId) return null;
			return createTinyMceProxy(editorId);
		}

		const normalized = target.charAt(0) === '#' ? target.substring(1) : target;
		if (!normalized) return null;

		return document.getElementById(normalized);
	}

	function configure(btn) {
		if (!btn || btn.dataset.scribeAttached === '1') return;

		const target = resolveTarget(btn);
		if (!target) return;

		window.initScribe(btn, target);
		btn.dataset.scribeAttached = '1';
	}

	function scanAndConfigure(root) {
		const scope = root || document;
		const buttons = scope.querySelectorAll('[data-scribe-target]');
		for (let i = 0; i < buttons.length; i++) {
			configure(buttons[i]);
		}
	}

	function onReady() {
		scanAndConfigure(document);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', onReady);
	} else {
		onReady();
	}

	document.addEventListener('click', (evt) => {
		const target = evt.target instanceof Element ? evt.target.closest('[data-scribe-target]') : null;
		if (target) {
			configure(target);
		}
	}, true);

	window.ScribeAutoInit = {
		refresh(root) {
			scanAndConfigure(root || document);
		}
	};
})();


