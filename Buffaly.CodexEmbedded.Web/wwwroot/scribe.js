(function () {
  const SILENCE_GAP_MS = 850;
  const MIN_SEGMENT_MS = 1400;
  const TARGET_INCREMENTAL_SEGMENT_MS = 3200;
  const RECORDER_SLICE_MS = 300;
  const RMS_THRESHOLD = 0.02;
  const VAD_POLL_MS = 100;
  const MAX_SEGMENT_MS = 8000;
  const LIVE_RETRANSCRIBE_MS = 2000;
  const LIVE_WAV_SAMPLE_RATE = 16000;
  const PCM_BUFFER_SIZE = 4096;
  const SUGGESTED_LANGUAGE_STORAGE_KEY = "codex.voice.transcribeLanguage";
  const INCREMENTAL_TRANSCRIBE_TIMEOUT_MS = 30000;
  const FINAL_TRANSCRIBE_TIMEOUT_MS = 90000;
  const ARCHIVE_STOP_TIMEOUT_MS = 5000;

  function isSupported() {
    return typeof window.MediaRecorder === "function"
      && !!navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === "function";
  }

  function inferExtension(mimeType) {
    const normalized = String(mimeType || "").toLowerCase();
    if (normalized.includes("wav")) {
      return "wav";
    }
    if (normalized.includes("mp4") || normalized.includes("m4a")) {
      return "m4a";
    }
    return "webm";
  }

  function chooseMimeType() {
    if (!isSupported()) {
      return "";
    }
    const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const candidate of preferred) {
      if (window.MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }
    return "";
  }

  function createVisualizer(buttonEl) {
    const visual = document.createElement("span");
    visual.className = "scribe-vis";
    visual.setAttribute("aria-hidden", "true");
    visual.innerHTML = [
      '<span class="scribe-dot"></span>',
      '<span class="scribe-time">0:00</span>',
      '<canvas class="scribe-wave"></canvas>'
    ].join("");

    if (buttonEl && buttonEl.parentNode) {
      buttonEl.parentNode.insertBefore(visual, buttonEl.nextSibling);
    }

    const timeEl = visual.querySelector(".scribe-time");
    const canvasEl = visual.querySelector(".scribe-wave");
    const ctx = canvasEl ? canvasEl.getContext("2d") : null;
    let rafId = null;
    let analyser = null;
    let data = null;
    let startAt = 0;
    let ampHistory = [];
    let speaking = false;
    let meter = 0;

    function fitCanvas() {
      if (!canvasEl) {
        return;
      }
      const widthCss = Math.max(1, canvasEl.clientWidth || 160);
      const heightCss = Math.max(1, canvasEl.clientHeight || 22);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.round(widthCss * dpr);
      const height = Math.round(heightCss * dpr);
      if (canvasEl.width !== width || canvasEl.height !== height) {
        canvasEl.width = width;
        canvasEl.height = height;
      }
    }

    function clear() {
      if (ctx && canvasEl) {
        fitCanvas();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      }
    }

    function formatElapsed(ms) {
      const seconds = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(seconds / 60);
      const rem = seconds % 60;
      return `${minutes}:${rem < 10 ? "0" : ""}${rem}`;
    }

    function renderWave() {
      rafId = requestAnimationFrame(renderWave);
      if (!ctx || !canvasEl || !analyser || !data) {
        return;
      }

      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = data[i];
        sum += value * value;
      }
      const rms = Math.sqrt(sum / data.length);
      meter = (meter * 0.75) + (rms * 0.25);
      const normalized = Math.max(0, Math.min(1, meter / 0.08));
      ampHistory.push(normalized);

      fitCanvas();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const width = canvasEl.width;
      const height = canvasEl.height;
      const barWidth = Math.max(2, Math.round(2 * dpr));
      const barGap = Math.max(1, Math.round(1 * dpr));
      const step = barWidth + barGap;
      const maxBars = Math.floor(width / step);
      if (ampHistory.length > maxBars) {
        ampHistory = ampHistory.slice(ampHistory.length - maxBars);
      }

      clear();
      const color = speaking ? "#ef4444" : "#0f172a";
      ctx.fillStyle = color;
      const center = height / 2;
      let x = width - barWidth;
      for (let i = ampHistory.length - 1; i >= 0 && x >= 0; i -= 1) {
        const frac = 0.08 + (ampHistory[i] * 0.92);
        const barHeight = Math.max(1, Math.round(height * frac));
        const y = Math.round(center - (barHeight / 2));
        ctx.fillRect(x, y, barWidth, barHeight);
        x -= step;
      }

      if (timeEl) {
        timeEl.textContent = formatElapsed(performance.now() - startAt);
      }
    }

    return {
      show() {
        visual.classList.add("is-active");
      },
      hide() {
        visual.classList.remove("is-active");
      },
      setSpeaking(next) {
        speaking = !!next;
      },
      start(nextAnalyser) {
        analyser = nextAnalyser || null;
        data = analyser ? new Float32Array(analyser.fftSize) : null;
        ampHistory = [];
        meter = 0;
        startAt = performance.now();
        this.show();
        if (!rafId) {
          rafId = requestAnimationFrame(renderWave);
        }
      },
      stop() {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        analyser = null;
        data = null;
        ampHistory = [];
        meter = 0;
        if (timeEl) {
          timeEl.textContent = "0:00";
        }
        clear();
        this.hide();
      },
      dispose() {
        this.stop();
        visual.remove();
      }
    };
  }

  function createDebugTray(buttonEl) {
    const tray = document.createElement("div");
    tray.className = "scribe-debug hidden";
    tray.innerHTML = [
      '<div class="scribe-debug-header">',
      '<span class="scribe-debug-title">Voice Capture</span>',
      '<div class="scribe-debug-actions">',
      '<button class="scribe-debug-retranscribe" type="button">Retranscribe</button>',
      '<button class="scribe-debug-clear" type="button">Clear</button>',
      "</div>",
      "</div>",
      '<div class="scribe-debug-section">',
      '<div class="scribe-debug-label">Full Recording</div>',
      '<audio class="scribe-debug-full" controls preload="metadata"></audio>',
      '<div class="scribe-debug-meta scribe-debug-full-meta">No recording yet.</div>',
      "</div>",
      '<div class="scribe-debug-section">',
      '<div class="scribe-debug-label">Chunks</div>',
      '<div class="scribe-debug-chunks"></div>',
      "</div>"
    ].join("");

    if (buttonEl && buttonEl.parentNode && buttonEl.parentNode.parentNode) {
      buttonEl.parentNode.parentNode.insertAdjacentElement("afterend", tray);
    }

    return {
      element: tray,
      retranscribeBtn: tray.querySelector(".scribe-debug-retranscribe"),
      clearBtn: tray.querySelector(".scribe-debug-clear"),
      fullAudio: tray.querySelector(".scribe-debug-full"),
      fullMeta: tray.querySelector(".scribe-debug-full-meta"),
      chunksEl: tray.querySelector(".scribe-debug-chunks"),
      show() {
        tray.classList.remove("hidden");
      },
      hide() {
        tray.classList.add("hidden");
      }
    };
  }

  function createDebugToggle(buttonEl) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "scribe-debug-toggle hidden";
    toggle.title = "Show voice debug";
    toggle.setAttribute("aria-label", "Show voice debug");
    toggle.setAttribute("aria-pressed", "false");
    toggle.innerHTML = '<i class="bi bi-question"></i>';

    if (buttonEl && buttonEl.parentNode) {
      buttonEl.parentNode.appendChild(toggle);
    }

    return {
      element: toggle,
      syncAnchor() {
        if (!buttonEl || !buttonEl.parentNode) {
          return;
        }
        const left = buttonEl.offsetLeft + buttonEl.offsetWidth - 2;
        const top = buttonEl.offsetTop + buttonEl.offsetHeight - 2;
        toggle.style.left = `${Math.round(left)}px`;
        toggle.style.top = `${Math.round(top)}px`;
      },
      show() {
        toggle.classList.remove("hidden");
      },
      hide() {
        toggle.classList.add("hidden");
      },
      setExpanded(expanded) {
        toggle.setAttribute("aria-pressed", expanded ? "true" : "false");
        toggle.title = expanded ? "Hide voice debug" : "Show voice debug";
        toggle.setAttribute("aria-label", expanded ? "Hide voice debug" : "Show voice debug");
      }
    };
  }

  function readErrorMessage(rawText) {
    const raw = String(rawText || "").trim();
    if (!raw) {
      return "";
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.message === "string" && parsed.message.trim()) {
          return parsed.message.trim();
        }
        if (typeof parsed.detail === "string" && parsed.detail.trim()) {
          return parsed.detail.trim();
        }
        if (typeof parsed.title === "string" && parsed.title.trim()) {
          return parsed.title.trim();
        }
      }
    } catch {
    }

    return raw;
  }

  function normalizeLanguageTag(value) {
    const candidate = String(value || "").trim().toLowerCase();
    if (!candidate || candidate === "auto") {
      return "";
    }
    return /^[a-z]{2,3}(-[a-z]{2})?$/.test(candidate) ? candidate : "";
  }

  function detectPreferredLanguage(options) {
    if (options && typeof options.transcribeLanguage === "string") {
      return normalizeLanguageTag(options.transcribeLanguage);
    }

    try {
      const saved = window.localStorage ? window.localStorage.getItem(SUGGESTED_LANGUAGE_STORAGE_KEY) : "";
      const normalizedSaved = normalizeLanguageTag(saved);
      if (normalizedSaved) {
        return normalizedSaved;
      }
    } catch {
    }

    return "en";
  }

  function formatBlobPrefixHex(bytes) {
    const hex = [];
    for (let i = 0; i < bytes.length; i += 1) {
      hex.push(bytes[i].toString(16).padStart(2, "0"));
    }
    return hex.join("");
  }

  function downsampleBuffer(input, inputSampleRate, outputSampleRate) {
    if (!input || input.length === 0) {
      return new Float32Array(0);
    }
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0 || inputSampleRate === outputSampleRate) {
      return input;
    }

    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(outputLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < output.length) {
      const nextOffsetBuffer = Math.min(input.length, Math.round((offsetResult + 1) * ratio));
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
        accum += input[i];
        count += 1;
      }
      output[offsetResult] = count > 0 ? (accum / count) : 0;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }
    return output;
  }

  function encodeWavBlobFromFloat32(samples, sampleRate) {
    const safeSamples = samples instanceof Float32Array ? samples : new Float32Array(0);
    const buffer = new ArrayBuffer(44 + (safeSamples.length * 2));
    const view = new DataView(buffer);
    const writeString = (offset, value) => {
      for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + (safeSamples.length * 2), true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, safeSamples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < safeSamples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, safeSamples[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }

    return new Blob([buffer], { type: "audio/wav" });
  }

  async function describeBlob(blob) {
    if (!blob || typeof blob.size !== "number") {
      return "blob=(missing)";
    }

    let prefix = "";
    try {
      const slice = blob.slice(0, 12);
      const buffer = await slice.arrayBuffer();
      prefix = formatBlobPrefixHex(new Uint8Array(buffer));
    } catch {
      prefix = "";
    }

    const signature = prefix
      ? (prefix.startsWith("1a45dfa3")
        ? "webm-ebml"
        : prefix.startsWith("52494646")
          ? "wav-riff"
          : prefix.startsWith("4f676753")
            ? "ogg"
            : prefix.startsWith("000000") && prefix.includes("66747970")
              ? "mp4-ftyp"
              : "unknown")
      : "unknown";
    return `size=${blob.size} type=${blob.type || "unknown"} prefix=${prefix || "(none)"} signature=${signature}`;
  }

  async function transcribeBlob(transcribeUrl, blob, language, timeoutMs, phase) {
    const extension = inferExtension(blob.type || "");
    const formData = new FormData();
    formData.append("file", blob, `speech_${Date.now()}.${extension}`);
    const safeLanguage = normalizeLanguageTag(language);
    if (safeLanguage) {
      formData.append("language", safeLanguage);
    }
    const safePhase = String(phase || "").trim().toLowerCase();
    if (safePhase === "incremental" || safePhase === "final") {
      formData.append("phase", safePhase);
    }
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.round(timeoutMs)
      : FINAL_TRANSCRIBE_TIMEOUT_MS;
    const controller = typeof AbortController === "function"
      ? new AbortController()
      : null;
    const timeoutHandle = controller
      ? setTimeout(() => {
        try {
          controller.abort();
        } catch {
        }
      }, timeout)
      : null;
    const startedAt = performance.now();
    let response;
    try {
      response = await fetch(transcribeUrl, {
        method: "POST",
        body: formData,
        signal: controller ? controller.signal : undefined
      });
    } catch (error) {
      const elapsedMs = Math.round(Math.max(0, performance.now() - startedAt));
      if (controller && controller.signal && controller.signal.aborted) {
        const timeoutError = new Error(`Transcription request timed out after ${timeout}ms`);
        timeoutError.status = 0;
        timeoutError.elapsedMs = elapsedMs;
        throw timeoutError;
      }
      if (error && typeof error === "object") {
        error.elapsedMs = elapsedMs;
      }
      throw error;
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const raw = (await response.text()).trim();
        if (raw) {
          detail = readErrorMessage(raw);
        }
      } catch {
      }
      const error = new Error(detail);
      error.status = response.status;
      error.elapsedMs = Math.round(Math.max(0, performance.now() - startedAt));
      throw error;
    }
    const text = await response.text();
    return {
      text,
      elapsedMs: Math.round(Math.max(0, performance.now() - startedAt))
    };
  }

  window.initScribe = function initScribe(config) {
    const options = config && typeof config === "object" ? config : {};
    const button = options.button;
    const target = options.target;
    const onLog = typeof options.onLog === "function" ? options.onLog : null;
    const onDraftSync = typeof options.onDraftSync === "function" ? options.onDraftSync : null;
    const beforeStart = typeof options.beforeStart === "function" ? options.beforeStart : null;
    const transcribeUrl = options.transcribeUrl || new URL("api/transcribe", document.baseURI);
    const transcribeLanguage = detectPreferredLanguage(options);

    if (!button || !target) {
      return null;
    }

    if (button.__scribeController) {
      return button.__scribeController;
    }

    const icon = button.querySelector("i");
    const visualizer = createVisualizer(button);
    const debugToggle = createDebugToggle(button);
    const debugTray = createDebugTray(button);
    const preferredMimeType = chooseMimeType();

    let stream = null;
    let audioContext = null;
    let analyser = null;
    let source = null;
    let pcmProcessor = null;
    let pcmSink = null;
    let vadTimer = null;

    let segmentRecorder = null;
    let segmentChunks = [];
    let segmentStartAt = 0;
    let lastSpeechAt = 0;
    let pendingSegmentStops = 0;
    let stopRequested = false;

    let archiveRecorder = null;
    let archiveChunks = [];
    let archiveBlob = null;
    let archiveResolve = null;
    let archivePromise = null;
    let pcmChunks = [];
    let pcmSampleCount = 0;

    let queueClosed = false;
    let isRecording = false;
    let isProcessing = false;
    let disposed = false;
    let recordingContext = null;
    let idleWaiters = [];
    let lastCapture = null;
    let debugTrayVisible = false;
    let liveRetranscribeTimer = null;
    let liveRetranscribeInFlight = false;
    let liveRetranscribeRequestId = 0;
    let lastAppliedLiveTranscript = "";

    function log(message) {
      if (onLog) {
        try {
          onLog(message);
        } catch {
        }
      }
    }

    function hasDebugCapture() {
      if (!lastCapture) {
        return false;
      }

      return !!(
        (lastCapture.fullBlob && lastCapture.fullBlob.size > 0)
        || (Array.isArray(lastCapture.chunks) && lastCapture.chunks.length > 0)
      );
    }

    function syncDebugUi() {
      const available = isRecording || isProcessing || hasDebugCapture();
      debugToggle.syncAnchor();
      if (available) {
        debugToggle.show();
      } else {
        debugToggle.hide();
        debugTrayVisible = false;
      }

      debugToggle.setExpanded(available && debugTrayVisible);
      if (available && debugTrayVisible) {
        debugTray.show();
      } else {
        debugTray.hide();
      }
    }

    function syncDraft() {
      if (onDraftSync) {
        try {
          onDraftSync();
        } catch {
        }
      }
    }

    function resolveIdleWaiters() {
      if (isRecording || isProcessing || idleWaiters.length === 0) {
        return;
      }

      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) {
        try {
          resolve();
        } catch {
        }
      }
    }

    function waitForIdle() {
      if (!isRecording && !isProcessing) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    }

    function setState(state) {
      if (state === "recording") {
        button.classList.add("is-recording");
        button.classList.remove("is-processing");
        button.disabled = false;
        button.setAttribute("aria-busy", "false");
        button.title = "Stop recording and transcribe";
        button.setAttribute("aria-label", "Stop recording and transcribe");
        if (icon) {
          icon.className = "bi bi-stop-fill";
        }
        return;
      }
      if (state === "processing") {
        button.classList.remove("is-recording");
        button.classList.add("is-processing");
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.title = "Transcribing...";
        button.setAttribute("aria-label", "Transcribing...");
        if (icon) {
          icon.className = "bi bi-arrow-repeat";
        }
        return;
      }
      if (state === "disabled") {
        button.classList.remove("is-recording");
        button.classList.remove("is-processing");
        button.disabled = true;
        button.setAttribute("aria-busy", "false");
        button.title = "Speech-to-text is unavailable in this browser";
        button.setAttribute("aria-label", "Speech-to-text is unavailable in this browser");
        if (icon) {
          icon.className = "bi bi-mic-mute-fill";
        }
        return;
      }

      button.classList.remove("is-recording");
      button.classList.remove("is-processing");
      button.disabled = false;
      button.setAttribute("aria-busy", "false");
      button.title = "Record speech to text";
      button.setAttribute("aria-label", "Record speech to text");
      if (icon) {
        icon.className = "bi bi-mic-fill";
      }
    }

    function enqueueSegment(blob, voicedMs) {
      if (!blob || blob.size <= 0 || queueClosed) {
        return;
      }
      const roundedVoicedMs = Number.isFinite(voicedMs) ? Math.max(0, Math.round(voicedMs)) : 0;
      const capture = ensureLastCapture();
      capture.chunks.push({
        blob,
        voicedMs: roundedVoicedMs,
        transcript: "",
        objectUrl: URL.createObjectURL(blob)
      });
      renderLastCapture();
    }

    function closeQueue() {
      if (queueClosed) {
        return;
      }
      queueClosed = true;
    }

    function maybeCloseQueue() {
      if (!stopRequested) {
        return;
      }
      const segmentDone = pendingSegmentStops <= 0 && (!segmentRecorder || segmentRecorder.state === "inactive");
      const archiveDone = !archiveRecorder || archiveRecorder.state === "inactive";
      if (segmentDone && archiveDone) {
        closeQueue();
      }
    }

    function buildLiveSnapshot() {
      if (!Array.isArray(pcmChunks) || pcmChunks.length === 0 || pcmSampleCount <= 0 || !audioContext) {
        return null;
      }

      const merged = new Float32Array(pcmSampleCount);
      let offset = 0;
      for (const chunk of pcmChunks) {
        if (!chunk || !chunk.length) {
          continue;
        }
        merged.set(chunk, offset);
        offset += chunk.length;
      }

      const downsampled = downsampleBuffer(merged, audioContext.sampleRate, LIVE_WAV_SAMPLE_RATE);
      const blob = encodeWavBlobFromFloat32(downsampled, LIVE_WAV_SAMPLE_RATE);
      return blob.size > 44 ? blob : null;
    }

    async function requestLiveRetranscription() {
      if (disposed || !isRecording || stopRequested) {
        return;
      }

      if (liveRetranscribeInFlight) {
        return;
      }

      const snapshot = buildLiveSnapshot();
      if (!snapshot) {
        return;
      }

      liveRetranscribeInFlight = true;
      liveRetranscribeRequestId += 1;
      const requestId = liveRetranscribeRequestId;
      try {
        const { text, elapsedMs } = await transcribeBlob(
          transcribeUrl,
          snapshot,
          transcribeLanguage,
          INCREMENTAL_TRANSCRIBE_TIMEOUT_MS,
          "incremental");
        const normalized = String(text || "").trim();
        log(
          `[voice] live retranscription ok requestId=${requestId} chars=${normalized.length} elapsedMs=${elapsedMs} ` +
          `blobBytes=${snapshot.size} mime=${snapshot.type || "unknown"} language=${transcribeLanguage || "auto"}`);
        if (requestId !== liveRetranscribeRequestId) {
          log(`[voice] live retranscription ignored stale result requestId=${requestId}`);
        } else if (normalized && isRecording && !stopRequested && !disposed) {
          if (!shouldApplyLiveTranscript(normalized)) {
            log(
              `[voice] live retranscription ignored regressive result requestId=${requestId} ` +
              `chars=${normalized.length} previousChars=${lastAppliedLiveTranscript.length}`);
          } else if (applyScopedTranscript(normalized)) {
            lastAppliedLiveTranscript = normalized;
            log("[voice] live retranscription replaced current recording slice");
          } else {
            log("[voice] live retranscription apply skipped");
          }
        } else if (normalized) {
          log("[voice] live retranscription result ignored because recording state changed");
        } else {
          log("[voice] live retranscription returned no text");
        }
      } catch (error) {
        const elapsed = Number(error && error.elapsedMs);
        const elapsedSuffix = Number.isFinite(elapsed) ? ` elapsedMs=${elapsed}` : "";
        log(
          `[voice] live retranscription failed: ${error}` +
          `${elapsedSuffix} blobBytes=${snapshot.size} mime=${snapshot.type || "unknown"}`);
      } finally {
        liveRetranscribeInFlight = false;
      }
    }

    function startLiveRetranscribeLoop() {
      if (liveRetranscribeTimer) {
        clearInterval(liveRetranscribeTimer);
      }
      liveRetranscribeTimer = window.setInterval(() => {
        requestLiveRetranscription();
      }, LIVE_RETRANSCRIBE_MS);
    }

    function stopLiveRetranscribeLoop() {
      if (liveRetranscribeTimer) {
        clearInterval(liveRetranscribeTimer);
        liveRetranscribeTimer = null;
      }
    }

    async function waitForLiveRetranscribeIdle() {
      while (liveRetranscribeInFlight) {
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
    }

    function applyTargetValue(nextValue, caretAt = null) {
      target.value = nextValue;
      syncDraft();
      target.focus();
      const fallbackCaret = target.value.length;
      const numericCaret = Number(caretAt);
      const safeCaret = Number.isFinite(numericCaret)
        ? Math.max(0, Math.min(fallbackCaret, Math.floor(numericCaret)))
        : fallbackCaret;
      try {
        target.selectionStart = target.selectionEnd = safeCaret;
      } catch {
        // Some proxy targets may not expose selection range.
      }
    }

    function createRecordingContext() {
      const current = String(target.value || "");
      const selectionStart = Number.isFinite(target.selectionStart) ? Math.floor(target.selectionStart) : current.length;
      const selectionEnd = Number.isFinite(target.selectionEnd) ? Math.floor(target.selectionEnd) : selectionStart;
      const boundedStart = Math.max(0, Math.min(current.length, selectionStart));
      const boundedEnd = Math.max(boundedStart, Math.min(current.length, selectionEnd));
      // Starting voice capture should not wipe a pre-selected prompt. Treat any active
      // selection as an insertion point at its trailing edge so only dictated text is replaced.
      const insertionStart = boundedEnd > boundedStart ? boundedEnd : boundedStart;
      return {
        start: insertionStart,
        end: insertionStart,
        separator: insertionStart > 0 && !/\s$/.test(current.slice(0, insertionStart)) ? "\n" : "",
        segmentTexts: []
      };
    }

    function shouldApplyLiveTranscript(normalizedText) {
      const normalized = String(normalizedText || "").trim();
      if (!normalized) {
        return false;
      }

      const previous = String(lastAppliedLiveTranscript || "").trim();
      if (!previous) {
        return true;
      }

      if (normalized.length >= previous.length) {
        return true;
      }

      // Live results are provisional. Do not replace a fuller in-progress transcript with
      // a much shorter fragment; the final full transcription is still authoritative.
      const minimumAcceptedLength = previous.length < 32
        ? Math.max(1, previous.length - 8)
        : Math.floor(previous.length * 0.75);
      return normalized.length >= minimumAcceptedLength;
    }

    function applyScopedTranscript(normalizedText) {
      const normalized = String(normalizedText || "").trim();
      if (!normalized) {
        return false;
      }

      if (!recordingContext) {
        recordingContext = createRecordingContext();
      }

      const applyWithinCurrentContext = () => {
        const context = recordingContext;
        if (!context) {
          return false;
        }

        const current = String(target.value || "");
        if (context.start < 0 || context.end < context.start || context.end > current.length) {
          return false;
        }

        const scopedText = `${context.separator}${normalized}`;
        const next = `${current.slice(0, context.start)}${scopedText}${current.slice(context.end)}`;
        context.end = context.start + scopedText.length;
        applyTargetValue(next, context.end);
        return true;
      };

      if (applyWithinCurrentContext()) {
        return true;
      }

      // If the composer changed externally while recording, reset to append mode
      // and scope this recording to a new tail slice instead of replacing all text.
      recordingContext = createRecordingContext();
      return applyWithinCurrentContext();
    }

    function applyFinalTranscript(text) {
      const normalized = String(text || "").trim();
      if (!normalized) {
        return false;
      }
      return applyScopedTranscript(normalized);
    }

    function revokeCaptureUrls(capture) {
      if (!capture) {
        return;
      }

      if (capture.fullObjectUrl) {
        try {
          URL.revokeObjectURL(capture.fullObjectUrl);
        } catch {
        }
      }

      if (Array.isArray(capture.chunks)) {
        for (const chunk of capture.chunks) {
          if (!chunk || !chunk.objectUrl) {
            continue;
          }
          try {
            URL.revokeObjectURL(chunk.objectUrl);
          } catch {
          }
        }
      }
    }

    function clearLastCapture() {
      revokeCaptureUrls(lastCapture);
      lastCapture = null;
      debugTrayVisible = false;
      if (debugTray.fullAudio) {
        debugTray.fullAudio.removeAttribute("src");
        debugTray.fullAudio.load();
      }
      if (debugTray.fullMeta) {
        debugTray.fullMeta.textContent = "No recording yet.";
      }
      if (debugTray.chunksEl) {
        debugTray.chunksEl.innerHTML = "";
      }
      syncDebugUi();
    }

    function ensureLastCapture() {
      if (lastCapture) {
        return lastCapture;
      }

      lastCapture = {
        fullBlob: null,
        fullObjectUrl: "",
        chunks: []
      };
      return lastCapture;
    }

    function renderLastCapture() {
      if (!lastCapture) {
        clearLastCapture();
        return;
      }

      if (debugTray.fullAudio) {
        debugTray.fullAudio.src = lastCapture.fullObjectUrl || "";
      }
      if (debugTray.fullMeta) {
        debugTray.fullMeta.textContent =
          `bytes=${lastCapture.fullBlob ? lastCapture.fullBlob.size : 0} type=${lastCapture.fullBlob ? (lastCapture.fullBlob.type || "unknown") : "unknown"} chunks=${lastCapture.chunks.length}`;
      }
      if (debugTray.chunksEl) {
        debugTray.chunksEl.innerHTML = "";
        for (let i = 0; i < lastCapture.chunks.length; i += 1) {
          const chunk = lastCapture.chunks[i];
          const row = document.createElement("div");
          row.className = "scribe-debug-chunk";
          const transcript = String(chunk.transcript || "").trim();
          const header = document.createElement("div");
          header.className = "scribe-debug-chunk-head";
          header.textContent = `Chunk ${i + 1}`;

          const audio = document.createElement("audio");
          audio.controls = true;
          audio.preload = "metadata";
          if (chunk.objectUrl) {
            audio.src = chunk.objectUrl;
          }

          const meta = document.createElement("div");
          meta.className = "scribe-debug-meta";
          meta.textContent =
            `bytes=${chunk.blob ? chunk.blob.size : 0} voicedMs=${chunk.voicedMs || 0} chars=${transcript.length}`;

          const text = document.createElement("div");
          text.className = "scribe-debug-text";
          text.textContent = transcript || "(no transcript yet)";

          row.appendChild(header);
          row.appendChild(audio);
          row.appendChild(meta);
          row.appendChild(text);
          debugTray.chunksEl.appendChild(row);
        }
      }
      syncDebugUi();
    }

    function resetAudioGraph() {
      if (vadTimer) {
        clearInterval(vadTimer);
        vadTimer = null;
      }
      try {
        if (source) {
          source.disconnect();
        }
      } catch {
      }
      source = null;
      try {
        if (pcmProcessor) {
          pcmProcessor.disconnect();
        }
      } catch {
      }
      pcmProcessor = null;
      try {
        if (pcmSink) {
          pcmSink.disconnect();
        }
      } catch {
      }
      pcmSink = null;
      analyser = null;
      if (audioContext) {
        try {
          audioContext.close();
        } catch {
        }
      }
      audioContext = null;
      if (stream) {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {
          }
        }
      }
      stream = null;
      pcmChunks = [];
      pcmSampleCount = 0;
      visualizer.setSpeaking(false);
      visualizer.stop();
    }

    function startSegment(atMs) {
      if (!stream || disposed || stopRequested) {
        return;
      }
      segmentRecorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      segmentChunks = [];
      segmentStartAt = atMs;
      lastSpeechAt = atMs;
      pendingSegmentStops += 1;

      segmentRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          segmentChunks.push(event.data);
        }
      };

      segmentRecorder.onstop = () => {
        const voicedMs = Math.max(0, lastSpeechAt - segmentStartAt);
        if (voicedMs >= MIN_SEGMENT_MS && segmentChunks.length > 0) {
          const keep = Math.max(1, Math.min(segmentChunks.length, Math.ceil(voicedMs / RECORDER_SLICE_MS)));
          const type = segmentChunks[0] ? segmentChunks[0].type : (preferredMimeType || "audio/webm");
          const blob = new Blob(segmentChunks.slice(0, keep), { type });
          enqueueSegment(blob, voicedMs);
        }
        segmentChunks = [];
        segmentRecorder = null;
        pendingSegmentStops = Math.max(0, pendingSegmentStops - 1);
        maybeCloseQueue();
      };

      segmentRecorder.start(RECORDER_SLICE_MS);
    }

    function stopSegment() {
      if (!segmentRecorder) {
        return;
      }
      try {
        if (segmentRecorder.state !== "inactive") {
          segmentRecorder.stop();
        }
      } catch {
      }
    }

    async function startCapture() {
      if (isRecording || isProcessing || disposed) {
        return;
      }
      if (!isSupported()) {
        setState("disabled");
        log("[voice] speech-to-text is not supported in this browser");
        return;
      }

      if (beforeStart) {
        try {
          const canStart = await beforeStart();
          if (canStart === false) {
            return;
          }
        } catch (error) {
          log(`[voice] cannot start recording: ${error}`);
          return;
        }
      }

      queueClosed = false;
      archiveBlob = null;
      clearLastCapture();
      stopRequested = false;
      pendingSegmentStops = 0;
      segmentRecorder = null;
      segmentChunks = [];
      pcmChunks = [];
      pcmSampleCount = 0;
      recordingContext = createRecordingContext();
      lastAppliedLiveTranscript = "";
      liveRetranscribeInFlight = false;
      liveRetranscribeRequestId = 0;

      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === "suspended") {
          await audioContext.resume();
        }
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        pcmProcessor = audioContext.createScriptProcessor(PCM_BUFFER_SIZE, 1, 1);
        pcmSink = audioContext.createGain();
        pcmSink.gain.value = 0;
        pcmProcessor.onaudioprocess = (event) => {
          if (!isRecording || stopRequested || disposed) {
            return;
          }
          const input = event.inputBuffer;
          if (!input || input.numberOfChannels <= 0) {
            return;
          }
          const channel = input.getChannelData(0);
          if (!channel || channel.length === 0) {
            return;
          }
          const copy = new Float32Array(channel.length);
          copy.set(channel);
          pcmChunks.push(copy);
          pcmSampleCount += copy.length;
          const output = event.outputBuffer;
          if (output && output.numberOfChannels > 0) {
            for (let channelIndex = 0; channelIndex < output.numberOfChannels; channelIndex += 1) {
              output.getChannelData(channelIndex).fill(0);
            }
          }
        };
        source.connect(pcmProcessor);
        pcmProcessor.connect(pcmSink);
        pcmSink.connect(audioContext.destination);

        archiveChunks = [];
        archivePromise = new Promise((resolve) => {
          archiveResolve = resolve;
        });
        archiveRecorder = preferredMimeType
          ? new MediaRecorder(stream, { mimeType: preferredMimeType })
          : new MediaRecorder(stream);
        archiveRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            archiveChunks.push(event.data);
          }
        };
        archiveRecorder.onstop = () => {
          const chunkCount = archiveChunks.length;
          const rawBytes = archiveChunks.reduce((sum, chunk) => sum + (chunk ? chunk.size : 0), 0);
          if (archiveChunks.length > 0) {
            const type = archiveChunks[0] ? archiveChunks[0].type : (preferredMimeType || "audio/webm");
            archiveBlob = new Blob(archiveChunks, { type });
          } else {
            archiveBlob = null;
          }
          log(
            `[voice] archive recorder stopped chunks=${chunkCount} rawBytes=${rawBytes} ` +
            `blobBytes=${archiveBlob ? archiveBlob.size : 0} blobType=${archiveBlob ? (archiveBlob.type || "unknown") : "none"}`);
          archiveChunks = [];
          if (archiveResolve) {
            archiveResolve(archiveBlob);
          }
          archiveResolve = null;
          maybeCloseQueue();
        };
        archiveRecorder.start(RECORDER_SLICE_MS);

        visualizer.start(analyser);
        isRecording = true;
        setState("recording");
        syncDebugUi();
        log("[voice] recording started");
        startLiveRetranscribeLoop();

        const vadData = new Float32Array(analyser.fftSize);
        let isSpeaking = false;
        let silenceMs = 0;

        vadTimer = setInterval(() => {
          if (!analyser || disposed) {
            return;
          }
          analyser.getFloatTimeDomainData(vadData);
          let sum = 0;
          for (let i = 0; i < vadData.length; i += 1) {
            const value = vadData[i];
            sum += value * value;
          }
          const rms = Math.sqrt(sum / vadData.length);
          const now = performance.now();

          if (segmentRecorder && (now - segmentStartAt) >= MAX_SEGMENT_MS) {
            log(`[voice] segment cut at max window voicedMs=${Math.max(0, lastSpeechAt - segmentStartAt)}`);
            stopSegment();
            silenceMs = 0;
            isSpeaking = false;
          }

          if (rms >= RMS_THRESHOLD) {
            if (!segmentRecorder && !stopRequested) {
              startSegment(now);
            }
            lastSpeechAt = now;
            silenceMs = 0;
            isSpeaking = true;
          } else if (segmentRecorder) {
            silenceMs += VAD_POLL_MS;
            const voicedMs = Math.max(0, lastSpeechAt - segmentStartAt);
            if (silenceMs >= SILENCE_GAP_MS && voicedMs >= TARGET_INCREMENTAL_SEGMENT_MS) {
              log(`[voice] segment cut on silence voicedMs=${voicedMs} silenceMs=${silenceMs}`);
              stopSegment();
              silenceMs = 0;
              isSpeaking = false;
            }
          } else {
            isSpeaking = false;
          }

          visualizer.setSpeaking(isSpeaking);
          button.classList.toggle("speaking", isSpeaking);
        }, VAD_POLL_MS);
      } catch (error) {
        stopLiveRetranscribeLoop();
        resetAudioGraph();
        isRecording = false;
        recordingContext = null;
        setState("idle");
        syncDebugUi();
        resolveIdleWaiters();
        log(`[voice] unable to start microphone capture: ${error}`);
      }
    }

    async function stopCapture() {
      if (!isRecording || isProcessing || disposed) {
        return;
      }
      isRecording = false;
      isProcessing = true;
      setState("processing");
      syncDebugUi();
      button.classList.remove("speaking");
      visualizer.setSpeaking(false);
      stopRequested = true;

      if (vadTimer) {
        clearInterval(vadTimer);
        vadTimer = null;
      }

      stopLiveRetranscribeLoop();

      stopSegment();

      if (archiveRecorder) {
        try {
          if (archiveRecorder.state !== "inactive") {
            archiveRecorder.stop();
          }
        } catch {
          if (archiveResolve) {
            archiveResolve(null);
            archiveResolve = null;
          }
        }
      } else if (archiveResolve) {
        archiveResolve(null);
        archiveResolve = null;
      }

      if (!segmentRecorder && pendingSegmentStops <= 0) {
        maybeCloseQueue();
      }

      await waitForLiveRetranscribeIdle();

      let fullBlob = null;
      try {
        if (archivePromise) {
          const timeoutPromise = new Promise((resolve) => {
            window.setTimeout(() => resolve(null), ARCHIVE_STOP_TIMEOUT_MS);
          });
          fullBlob = await Promise.race([archivePromise, timeoutPromise]);
          if (!fullBlob) {
            log(`[voice] archive recorder did not flush within ${ARCHIVE_STOP_TIMEOUT_MS}ms`);
          }
        } else {
          fullBlob = null;
        }
      } catch {
      }
      archivePromise = null;
      archiveRecorder = null;
      resetAudioGraph();

      if (fullBlob && fullBlob.size > 0) {
        const capture = ensureLastCapture();
        capture.fullBlob = fullBlob;
        capture.fullObjectUrl = URL.createObjectURL(fullBlob);
        renderLastCapture();
      }

      if (fullBlob && fullBlob.size > 0) {
        try {
          const blobInfo = await describeBlob(fullBlob);
          log(`[voice] final blob info ${blobInfo}`);
          const { text: fullText, elapsedMs } = await transcribeBlob(
            transcribeUrl,
            fullBlob,
            transcribeLanguage,
            FINAL_TRANSCRIBE_TIMEOUT_MS,
            "final");
          const normalized = String(fullText || "").trim();
          log(
            `[voice] final transcription ok chars=${normalized.length} ` +
            `elapsedMs=${elapsedMs} blobBytes=${fullBlob.size} mime=${fullBlob.type || "unknown"} ` +
            `language=${transcribeLanguage || "auto"}`);
          if (!normalized) {
            log("[voice] final transcription returned no text");
          } else if (applyFinalTranscript(fullText)) {
            lastAppliedLiveTranscript = normalized;
            log("[voice] final transcription replaced this recording slice");
          } else {
            log("[voice] final transcription append skipped");
          }
        } catch (error) {
          const elapsed = Number(error && error.elapsedMs);
          const elapsedSuffix = Number.isFinite(elapsed) ? ` elapsedMs=${elapsed}` : "";
          log(
            `[voice] final transcription failed: ${error}` +
            `${elapsedSuffix} blobBytes=${fullBlob.size} mime=${fullBlob.type || "unknown"}`);
        }
      }

      isProcessing = false;
      lastAppliedLiveTranscript = "";
      recordingContext = null;
      setState("idle");
      syncDebugUi();
      resolveIdleWaiters();
    }

    async function stopAndWaitForIdle() {
      if (disposed) {
        return;
      }

      if (isRecording) {
        await stopCapture();
        return;
      }

      await waitForIdle();
    }

    async function retranscribeLastCapture() {
      if (disposed || isRecording || isProcessing || !lastCapture || !lastCapture.fullBlob) {
        return;
      }

      isProcessing = true;
      setState("processing");
      syncDebugUi();
      try {
        log("[voice] retranscribing saved full audio");
        const { text: fullText, elapsedMs } = await transcribeBlob(
          transcribeUrl,
          lastCapture.fullBlob,
          transcribeLanguage,
          FINAL_TRANSCRIBE_TIMEOUT_MS,
          "final");
        const normalized = String(fullText || "").trim();
        log(
          `[voice] retranscription ok chars=${normalized.length} elapsedMs=${elapsedMs} ` +
          `blobBytes=${lastCapture.fullBlob.size} mime=${lastCapture.fullBlob.type || "unknown"} language=${transcribeLanguage || "auto"}`);
        if (!normalized) {
          log("[voice] retranscription returned no text");
        } else if (applyFinalTranscript(fullText)) {
          lastAppliedLiveTranscript = normalized;
          log("[voice] retranscription replaced this recording slice");
        } else {
          log("[voice] retranscription append skipped");
        }
      } catch (error) {
        const elapsed = Number(error && error.elapsedMs);
        const elapsedSuffix = Number.isFinite(elapsed) ? ` elapsedMs=${elapsed}` : "";
        log(
          `[voice] retranscription failed: ${error}` +
          `${elapsedSuffix} blobBytes=${lastCapture.fullBlob.size} mime=${lastCapture.fullBlob.type || "unknown"}`);
      } finally {
        isProcessing = false;
        setState("idle");
        syncDebugUi();
        resolveIdleWaiters();
      }
    }

    function toggleDebugTray() {
      const available = isRecording || isProcessing || hasDebugCapture();
      if (!available) {
        return;
      }

      debugTrayVisible = !debugTrayVisible;
      syncDebugUi();
    }

    async function onClick() {
      if (disposed) {
        return;
      }
      if (isRecording) {
        await stopCapture();
        return;
      }
      await startCapture();
    }

    async function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      button.removeEventListener("click", onClick);
      if (isRecording) {
        try {
          await stopCapture();
        } catch {
        }
      } else {
        resetAudioGraph();
      }
      clearLastCapture();
      closeQueue();
      visualizer.dispose();
      if (debugTray.retranscribeBtn) {
        debugTray.retranscribeBtn.removeEventListener("click", retranscribeLastCapture);
      }
      if (debugTray.clearBtn) {
        debugTray.clearBtn.removeEventListener("click", clearLastCapture);
      }
      debugToggle.element.removeEventListener("click", toggleDebugTray);
      debugToggle.element.remove();
      debugTray.element.remove();
      button.classList.remove("speaking");
      setState("idle");
      resolveIdleWaiters();
      delete button.__scribeController;
    }

    button.addEventListener("click", onClick);
    if (debugTray.retranscribeBtn) {
      debugTray.retranscribeBtn.addEventListener("click", retranscribeLastCapture);
    }
    if (debugTray.clearBtn) {
      debugTray.clearBtn.addEventListener("click", clearLastCapture);
    }
    debugToggle.element.addEventListener("click", toggleDebugTray);

    const controller = {
      start: startCapture,
      stop: stopCapture,
      stopAndWaitForIdle,
      retranscribeLastCapture,
      dispose,
      get recording() {
        return isRecording;
      },
      get processing() {
        return isProcessing;
      }
    };

    button.__scribeController = controller;

    if (!isSupported()) {
      setState("disabled");
    } else {
      setState("idle");
    }
    syncDebugUi();

    return controller;
  };
})();
