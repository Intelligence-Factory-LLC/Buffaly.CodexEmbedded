(function () {
  const SILENCE_GAP_MS = 550;
  const MIN_SEGMENT_MS = 1400;
  const RECORDER_SLICE_MS = 300;
  const RMS_THRESHOLD = 0.02;
  const VAD_POLL_MS = 100;
  const MAX_SEGMENT_MS = 8000;
  const MIN_INCREMENTAL_CHARS = 10;
  const FINAL_REPLACE_GAIN_CHARS = 20;
  const SUGGESTED_LANGUAGE_STORAGE_KEY = "codex.voice.transcribeLanguage";

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

    const browserLanguage = normalizeLanguageTag(
      (navigator.languages && navigator.languages.length > 0 ? navigator.languages[0] : navigator.language) || "");
    if (browserLanguage === "en" || browserLanguage.startsWith("en-")) {
      return "en";
    }

    return "";
  }

  function hasScriptMismatch(text, expectedLanguage) {
    if (!text || !expectedLanguage || !expectedLanguage.startsWith("en")) {
      return false;
    }

    let letterCount = 0;
    let latinCount = 0;
    let cyrillicCount = 0;
    for (const ch of String(text)) {
      if (/[A-Za-z]/.test(ch)) {
        letterCount += 1;
        latinCount += 1;
        continue;
      }
      if (/[\u0400-\u04FF]/.test(ch)) {
        letterCount += 1;
        cyrillicCount += 1;
      }
    }

    if (letterCount < 8) {
      return false;
    }

    const latinShare = latinCount / letterCount;
    const cyrillicShare = cyrillicCount / letterCount;
    return cyrillicShare >= 0.35 && latinShare <= 0.45;
  }

  function shouldReplaceWithFinalTranscript(finalText, incrementalText) {
    const finalChars = String(finalText || "").trim().length;
    const incrementalChars = String(incrementalText || "").trim().length;
    if (finalChars <= 0) {
      return false;
    }
    if (incrementalChars <= 0) {
      return true;
    }

    return finalChars >= (incrementalChars + FINAL_REPLACE_GAIN_CHARS)
      || finalChars >= Math.ceil(incrementalChars * 1.25);
  }

  async function transcribeBlob(transcribeUrl, blob, language) {
    const extension = inferExtension(blob.type || "");
    const formData = new FormData();
    formData.append("file", blob, `speech_${Date.now()}.${extension}`);
    const safeLanguage = normalizeLanguageTag(language);
    if (safeLanguage) {
      formData.append("language", safeLanguage);
    }
    const startedAt = performance.now();
    const response = await fetch(transcribeUrl, {
      method: "POST",
      body: formData
    });
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
    const preferredMimeType = chooseMimeType();

    let stream = null;
    let audioContext = null;
    let analyser = null;
    let source = null;
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

    let queue = [];
    let queueWaiters = [];
    let queueClosed = false;
    let processorPromise = null;
    let isRecording = false;
    let isProcessing = false;
    let disposed = false;
    let recordingContext = null;
    let skipFinalTranscriptionForCapture = false;
    let idleWaiters = [];

    function log(message) {
      if (onLog) {
        try {
          onLog(message);
        } catch {
        }
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
      const segment = {
        blob,
        voicedMs: Number.isFinite(voicedMs) ? Math.max(0, Math.round(voicedMs)) : 0
      };
      if (queueWaiters.length > 0) {
        const waiter = queueWaiters.shift();
        waiter(segment);
        return;
      }
      queue.push(segment);
    }

    function dequeueSegment() {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift());
      }
      if (queueClosed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        queueWaiters.push(resolve);
      });
    }

    function closeQueue() {
      if (queueClosed) {
        return;
      }
      queueClosed = true;
      while (queueWaiters.length > 0) {
        const waiter = queueWaiters.shift();
        waiter(null);
      }
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
      const insertionStart = Math.min(boundedStart, boundedEnd);
      return {
        start: insertionStart,
        end: boundedEnd,
        separator: insertionStart > 0 && !/\s$/.test(current.slice(0, insertionStart)) ? "\n" : "",
        segmentTexts: []
      };
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

    function appendIncrementalTranscript(text) {
      const normalized = String(text || "").trim();
      if (!normalized) {
        return false;
      }
      if (!recordingContext) {
        recordingContext = createRecordingContext();
      }
      recordingContext.segmentTexts.push(normalized);
      const merged = recordingContext.segmentTexts.join("\n");
      return applyScopedTranscript(merged);
    }

    function applyFinalTranscript(text) {
      const normalized = String(text || "").trim();
      if (!normalized) {
        return false;
      }
      return applyScopedTranscript(normalized);
    }

    function getIncrementalAggregateText() {
      if (!recordingContext || !Array.isArray(recordingContext.segmentTexts)) {
        return "";
      }
      return recordingContext.segmentTexts.join("\n").trim();
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

    async function runSegmentProcessor() {
      for (;;) {
        const segment = await dequeueSegment();
        if (!segment || !segment.blob) {
          return;
        }
        try {
          const { text, elapsedMs } = await transcribeBlob(transcribeUrl, segment.blob, transcribeLanguage);
          const normalized = String(text || "").trim();
          log(
            `[voice] incremental transcription ok chars=${normalized.length} ` +
            `elapsedMs=${elapsedMs} blobBytes=${segment.blob.size} voicedMs=${segment.voicedMs} ` +
            `mime=${segment.blob.type || "unknown"} language=${transcribeLanguage || "auto"}`);
          if (normalized && normalized.length < MIN_INCREMENTAL_CHARS) {
            log(`[voice] incremental transcription ignored for low chars=${normalized.length}`);
            continue;
          }
          if (normalized && hasScriptMismatch(normalized, transcribeLanguage)) {
            log("[voice] incremental transcription ignored for script mismatch");
            continue;
          }
          if (normalized) {
            if (appendIncrementalTranscript(normalized)) {
              log("[voice] incremental transcription appended");
            } else {
              log("[voice] incremental transcription append skipped");
            }
          } else {
            log("[voice] incremental transcription returned no text");
          }
        } catch (error) {
          const elapsed = Number(error && error.elapsedMs);
          const elapsedSuffix = Number.isFinite(elapsed) ? ` elapsedMs=${elapsed}` : "";
          log(
            `[voice] incremental transcription failed: ${error}` +
            `${elapsedSuffix} blobBytes=${segment.blob.size} voicedMs=${segment.voicedMs} mime=${segment.blob.type || "unknown"}`);
          if (Number(error && error.status) === 400) {
            skipFinalTranscriptionForCapture = true;
            queue = [];
            closeQueue();
            return;
          }
        }
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

      queue = [];
      queueWaiters = [];
      queueClosed = false;
      archiveBlob = null;
      stopRequested = false;
      pendingSegmentStops = 0;
      segmentRecorder = null;
      segmentChunks = [];
      recordingContext = createRecordingContext();
      skipFinalTranscriptionForCapture = false;

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
          if (archiveChunks.length > 0) {
            const type = archiveChunks[0] ? archiveChunks[0].type : (preferredMimeType || "audio/webm");
            archiveBlob = new Blob(archiveChunks, { type });
          } else {
            archiveBlob = null;
          }
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
        log("[voice] recording started");
        processorPromise = runSegmentProcessor();

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
            if (silenceMs >= SILENCE_GAP_MS && voicedMs >= MIN_SEGMENT_MS) {
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
        resetAudioGraph();
        isRecording = false;
        recordingContext = null;
        setState("idle");
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
      button.classList.remove("speaking");
      visualizer.setSpeaking(false);
      stopRequested = true;

      if (vadTimer) {
        clearInterval(vadTimer);
        vadTimer = null;
      }

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

      resetAudioGraph();

      try {
        if (processorPromise) {
          await processorPromise;
        }
      } catch {
      }
      processorPromise = null;

      let fullBlob = null;
      try {
        fullBlob = archivePromise ? await archivePromise : null;
      } catch {
      }
      archivePromise = null;
      archiveRecorder = null;

      if (!skipFinalTranscriptionForCapture && fullBlob && fullBlob.size > 0) {
        try {
          const { text: fullText, elapsedMs } = await transcribeBlob(transcribeUrl, fullBlob, transcribeLanguage);
          const normalized = String(fullText || "").trim();
          const incrementalAggregate = getIncrementalAggregateText();
          log(
            `[voice] final transcription ok chars=${normalized.length} ` +
            `elapsedMs=${elapsedMs} blobBytes=${fullBlob.size} mime=${fullBlob.type || "unknown"} ` +
            `language=${transcribeLanguage || "auto"} incrementalChars=${incrementalAggregate.length}`);
          if (!normalized) {
            log("[voice] final transcription returned no text");
          } else if (hasScriptMismatch(normalized, transcribeLanguage)) {
            log("[voice] final transcription ignored for script mismatch");
          } else if (shouldReplaceWithFinalTranscript(normalized, incrementalAggregate) && applyFinalTranscript(fullText)) {
            log("[voice] final transcription replaced this recording slice");
          } else {
            log("[voice] final transcription kept incremental aggregate");
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
      recordingContext = null;
      setState("idle");
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
      closeQueue();
      visualizer.dispose();
      button.classList.remove("speaking");
      setState("idle");
      resolveIdleWaiters();
      delete button.__scribeController;
    }

    button.addEventListener("click", onClick);

    const controller = {
      start: startCapture,
      stop: stopCapture,
      stopAndWaitForIdle,
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

    return controller;
  };
})();
