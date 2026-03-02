"use client";

import { ChevronLeft, Pause, Play, Repeat, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCaptions } from "../_hooks/use-captions";
import { useTypingEngine } from "../_hooks/use-typing-engine";
import { useYouTubePlayer } from "../_hooks/use-youtube-player";
import type { CueResult, Phase, PracticeMode } from "../_lib/types";

// Web Speech API types are provided by _lib/speech-recognition.d.ts

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const AUTO_ADVANCE_DELAY = 1200;
const PLAYER_ID = "ss-yt-player";
const RECENT_VIDEOS_KEY = "sub-scribe-recent-videos";
const MAX_RECENT_VIDEOS = 5;

interface RecentVideo {
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  url: string;
  lastPlayedAt: string;
}

export function SubScribe() {
  const captions = useCaptions();
  const [phase, setPhase] = useState<Phase>("url-input");
  const [urlInput, setUrlInput] = useState("");
  const [mode, setMode] = useState<PracticeMode>("type");
  const [activeCueIdx, setActiveCueIdx] = useState(0);
  const [results, setResults] = useState<CueResult[]>([]);
  const [looping, setLooping] = useState(false);
  const [rateIdx, setRateIdx] = useState(2); // Default 1x
  const [autoPlay, setAutoPlay] = useState(true);
  const [typingInputValue, setTypingInputValue] = useState("");
  const [composingText, setComposingText] = useState("");
  const [recentVideos, setRecentVideos] = useState<RecentVideo[]>([]);

  // Load recent videos from localStorage on client only (avoids hydration mismatch)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENT_VIDEOS_KEY);
      if (stored) setRecentVideos(JSON.parse(stored));
    } catch {}
  }, []);

  const inputRef = useRef<HTMLInputElement>(null);
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const activeCueIdxRef = useRef(activeCueIdx);
  activeCueIdxRef.current = activeCueIdx;

  const typing = useTypingEngine({
    onComplete: (wpm, accuracy) => {
      setResults((prev) => [
        ...prev,
        { cueIndex: activeCueIdxRef.current, accuracy, wpm, skipped: false },
      ]);
    },
  });

  // YouTube player — only mount when we have a videoId and are past track selection
  const shouldMountPlayer = !!captions.meta?.videoId && phase !== "url-input" && phase !== "error";
  const player = useYouTubePlayer({
    containerId: PLAYER_ID,
    videoId: captions.meta?.videoId ?? "",
  });

  // ── URL Submit ──
  const handleUrlSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = urlInput.trim();
      if (!trimmed) return;
      setPhase("loading");
      captions.fetchTracks(trimmed);
    },
    [urlInput, captions],
  );

  // ── React to captions loading state ──
  useEffect(() => {
    if (phase !== "loading") return;

    if (captions.error) {
      setPhase("error");
    } else if (captions.meta && !captions.loading) {
      if (captions.meta.captionTracks.length === 0) {
        setPhase("error");
      } else if (captions.cues.length > 0) {
        setPhase("mode-select");
      } else if (!captions.selectedLang) {
        setPhase("track-select");
      }
    }
  }, [
    phase,
    captions.error,
    captions.meta,
    captions.loading,
    captions.cues,
    captions.selectedLang,
  ]);

  // ── Save to recent videos when meta loads ──
  useEffect(() => {
    if (!captions.meta || captions.loading || captions.error) return;
    const meta = captions.meta;
    const url = urlInput.trim();
    if (!url) return;

    setRecentVideos((prev) => {
      const filtered = prev.filter((v) => v.videoId !== meta.videoId);
      const entry: RecentVideo = {
        videoId: meta.videoId,
        title: meta.title,
        channelName: meta.channelName,
        thumbnailUrl: meta.thumbnailUrl,
        url,
        lastPlayedAt: new Date().toISOString(),
      };
      const next = [entry, ...filtered].slice(0, MAX_RECENT_VIDEOS);
      try {
        localStorage.setItem(RECENT_VIDEOS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [captions.meta, captions.loading, captions.error, urlInput]);

  // ── Track Select ──
  const handleTrackSelect = useCallback(
    (lang: string, kind?: string) => {
      setPhase("loading");
      captions.fetchCues(lang, kind);
    },
    [captions],
  );

  // ── Advance to next cue ──
  const advanceCue = useCallback(() => {
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = null;
    }

    setActiveCueIdx((prev) => {
      const nextIdx = prev + 1;
      if (nextIdx >= captions.cues.length) {
        setPhase("session-done");
        player.pause();
        return prev;
      }
      return nextIdx;
    });
  }, [captions.cues.length, player.pause]);

  // ── Mode Select ──
  const handleModeSelect = useCallback(
    (m: PracticeMode) => {
      setMode(m);
      setActiveCueIdx(0);
      setResults([]);
      setPhase("practicing");

      if (m === "type" && captions.cues[0]) {
        typing.start(captions.cues[0].text);
        setTypingInputValue("");
      }

      if (player.ready && captions.cues[0]) {
        player.seekTo(captions.cues[0].start);
        player.play();
      }
    },
    [captions.cues, typing.start, player.ready, player.seekTo, player.play],
  );

  // ── Start typing when cue changes ──
  useEffect(() => {
    if (phase !== "practicing" || mode !== "type") return;
    const cue = captions.cues[activeCueIdx];
    if (!cue) return;
    typing.start(cue.text);
    setTypingInputValue("");
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [phase, mode, activeCueIdx, captions.cues, typing.start]);

  // ── Sync player to current cue ──
  useEffect(() => {
    if (phase !== "practicing") return;
    const cue = captions.cues[activeCueIdx];
    if (!cue || !player.ready) return;
    player.seekTo(cue.start);
    player.play();
  }, [phase, activeCueIdx, captions.cues, player.ready, player.seekTo, player.play]);

  // ── Pause at cue end for type/fill mode ──
  useEffect(() => {
    if (phase !== "practicing") return;
    if (mode === "speak") return;

    const cue = captions.cues[activeCueIdx];
    if (!cue) return;

    if (player.currentTime >= cue.end && player.playerState === "playing") {
      if (looping && !typing.state.done) {
        player.seekTo(cue.start);
      } else if (!typing.state.done) {
        player.pause();
      }
    }
  }, [
    phase,
    mode,
    activeCueIdx,
    captions.cues,
    player.currentTime,
    player.playerState,
    looping,
    typing.state.done,
    player.seekTo,
    player.pause,
  ]);

  // ── Auto-advance after typing done (only if perfect) ──
  useEffect(() => {
    if (phase !== "practicing" || mode !== "type") return;
    if (!typing.state.done || !autoPlay) return;
    if (typing.state.accuracy !== 100) return;

    autoAdvanceRef.current = setTimeout(() => {
      advanceCue();
    }, AUTO_ADVANCE_DELAY);

    return () => {
      if (autoAdvanceRef.current) {
        clearTimeout(autoAdvanceRef.current);
        autoAdvanceRef.current = null;
      }
    };
  }, [phase, mode, typing.state.done, typing.state.accuracy, autoPlay, advanceCue]);

  // ── Skip cue ──
  const skipCue = useCallback(() => {
    setResults((prev) => [...prev, { cueIndex: activeCueIdx, accuracy: 0, wpm: 0, skipped: true }]);
    advanceCue();
  }, [activeCueIdx, advanceCue]);

  // ── Tap area click ──
  const handleTapArea = useCallback(() => {
    if (typing.state.done && typing.state.accuracy === 100) {
      advanceCue();
    } else if (!typing.state.done) {
      inputRef.current?.focus();
    }
  }, [typing.state.done, typing.state.accuracy, advanceCue]);

  // ── Playback rate ──
  const cycleRate = useCallback(() => {
    const nextIdx = (rateIdx + 1) % PLAYBACK_RATES.length;
    setRateIdx(nextIdx);
    player.setPlaybackRate(PLAYBACK_RATES[nextIdx]);
  }, [rateIdx, player.setPlaybackRate]);

  // ── Go to previous cue ──
  const prevCue = useCallback(() => {
    if (activeCueIdx <= 0) return;

    // Clear auto-advance timer
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = null;
    }

    // Remove current cue's result if present
    setResults((prev) => {
      const lastResult = prev[prev.length - 1];
      if (lastResult && lastResult.cueIndex === activeCueIdx) {
        return prev.slice(0, -1);
      }
      return prev;
    });

    setActiveCueIdx((prev) => prev - 1);
  }, [activeCueIdx]);

  // ── Retry current cue (type mode) ──
  const retryCue = useCallback(() => {
    typing.reset();
    setTypingInputValue("");
    setResults((prev) => {
      const lastResult = prev[prev.length - 1];
      if (lastResult && lastResult.cueIndex === activeCueIdx) {
        return prev.slice(0, -1);
      }
      return prev;
    });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [typing, activeCueIdx]);

  // ── Fill mode state ──
  const [fillInput, setFillInput] = useState("");
  const [fillRevealed, setFillRevealed] = useState(false);
  const [fillBlankResults, setFillBlankResults] = useState<
    { blankIndex: number; expected: string; userAnswer: string; correct: boolean }[]
  >([]);
  const fillInputRef = useRef<HTMLInputElement>(null);

  const fillData = useMemo(() => {
    if (mode !== "fill" || phase !== "practicing") return null;
    const cue = captions.cues[activeCueIdx];
    if (!cue) return null;

    const words = cue.text.split(" ");
    const blankCount = Math.max(1, Math.round(words.length * 0.4));
    const indices = new Set<number>();

    let seed = activeCueIdx * 7 + 13;
    while (indices.size < blankCount && indices.size < words.length) {
      seed = (seed * 31 + 17) % 1000;
      indices.add(seed % words.length);
    }

    return { words, blankIndices: indices };
  }, [mode, phase, activeCueIdx, captions.cues]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeCueIdx triggers reset on cue change
  useEffect(() => {
    if (mode === "fill") {
      setFillInput("");
      setFillRevealed(false);
      setFillBlankResults([]);
      setTimeout(() => fillInputRef.current?.focus(), 50);
    }
  }, [mode, activeCueIdx]);

  const handleFillSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!fillData) return;

      const blankIndicesArr = [...fillData.blankIndices];
      const blankWords = blankIndicesArr.map((i) => fillData.words[i].toLowerCase());
      const userWords = fillInput.trim().toLowerCase().split(/\s+/).filter(Boolean);

      let correct = 0;
      const perBlank: typeof fillBlankResults = [];
      for (let i = 0; i < blankWords.length; i++) {
        const expected = blankWords[i].replace(/[.,!?;:'"()]/g, "").normalize("NFC");
        const actual = (userWords[i] ?? "").replace(/[.,!?;:'"()]/g, "").normalize("NFC");
        const isCorrect = expected === actual;
        if (isCorrect) correct++;
        perBlank.push({
          blankIndex: blankIndicesArr[i],
          expected,
          userAnswer: userWords[i] ?? "",
          correct: isCorrect,
        });
      }

      setFillBlankResults(perBlank);
      const accuracy = Math.round((correct / blankWords.length) * 100);
      setResults((prev) => [...prev, { cueIndex: activeCueIdx, accuracy, skipped: false }]);
      setFillRevealed(true);

      if (autoPlay) {
        autoAdvanceRef.current = setTimeout(advanceCue, AUTO_ADVANCE_DELAY * 1.5);
      }
    },
    [fillData, fillInput, activeCueIdx, autoPlay, advanceCue],
  );

  // ── Speak mode state ──
  const [isListening, setIsListening] = useState(false);
  const [spokenText, setSpokenText] = useState("");
  const [speakAccuracy, setSpeakAccuracy] = useState<number | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeCueIdx triggers reset on cue change
  useEffect(() => {
    if (mode === "speak") {
      setSpokenText("");
      setSpeakAccuracy(null);
      setIsListening(false);
    }
  }, [mode, activeCueIdx]);

  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SR =
      typeof window !== "undefined"
        ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
        : null;

    if (!SR) {
      return;
    }

    const cue = captions.cues[activeCueIdx];
    if (!cue) return;

    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = captions.selectedLang ?? "en";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      setSpokenText(transcript);
      setIsListening(false);

      const expected = cue.text
        .normalize("NFC")
        .toLowerCase()
        .replace(/[.,!?;:'"()]/g, "")
        .split(/\s+/);
      const actual = transcript
        .normalize("NFC")
        .toLowerCase()
        .replace(/[.,!?;:'"()]/g, "")
        .split(/\s+/);

      let matches = 0;
      for (let i = 0; i < expected.length; i++) {
        if (expected[i] === actual[i]) matches++;
      }
      const acc = Math.round((matches / Math.max(expected.length, 1)) * 100);
      setSpeakAccuracy(acc);

      setResults((prev) => [
        ...prev,
        { cueIndex: activeCueIdxRef.current, accuracy: acc, skipped: false },
      ]);

      if (autoPlay) {
        autoAdvanceRef.current = setTimeout(advanceCue, AUTO_ADVANCE_DELAY * 2);
      }
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);

    player.seekTo(cue.start);
    player.play();
  }, [isListening, captions, activeCueIdx, autoPlay, advanceCue, player.seekTo, player.play]);

  // ── Session stats ──
  const sessionStats = useMemo(() => {
    if (results.length === 0) return { completed: 0, skipped: 0, avgAccuracy: 0, avgWpm: 0 };

    const completed = results.filter((r) => !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    const avgAccuracy =
      completed.length > 0
        ? Math.round(completed.reduce((s, r) => s + r.accuracy, 0) / completed.length)
        : 0;
    const wpmResults = completed.filter((r) => r.wpm !== undefined && r.wpm > 0);
    const avgWpm =
      wpmResults.length > 0
        ? Math.round(wpmResults.reduce((s, r) => s + (r.wpm ?? 0), 0) / wpmResults.length)
        : 0;

    return { completed: completed.length, skipped: skipped.length, avgAccuracy, avgWpm };
  }, [results]);

  // ── Reset ──
  const handleReset = useCallback(() => {
    captions.reset();
    setPhase("url-input");
    setUrlInput("");
    setResults([]);
    setActiveCueIdx(0);
  }, [captions]);

  // ── Back to mode select ──
  const handleBackToModeSelect = useCallback(() => {
    setPhase("mode-select");
    player.pause();
    typing.reset();
    setTypingInputValue("");
    setResults([]);
    setActiveCueIdx(0);
    setFillInput("");
    setFillRevealed(false);
    setFillBlankResults([]);
    setSpokenText("");
    setSpeakAccuracy(null);
    setIsListening(false);
    recognitionRef.current?.stop();
  }, [player.pause, typing.reset]);

  const currentCue = captions.cues[activeCueIdx];
  const progressPct =
    captions.cues.length > 0 ? ((activeCueIdx + 1) / captions.cues.length) * 100 : 0;

  return (
    <div className="ss-root">
      <div className="ss-container">
        <div className="ss-header">
          <button type="button" className="ss-title" onClick={() => setPhase("url-input")}>
            Sub<span className="ss-title-accent">Scribe</span>
          </button>
          <div className="ss-header-actions">
            {phase === "practicing" && (
              <>
                <button
                  type="button"
                  className="ss-icon-btn ss-icon-btn--back"
                  onClick={handleBackToModeSelect}
                  aria-label="Back to mode select"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  className="ss-icon-btn ss-icon-btn--autoplay"
                  data-active={autoPlay || undefined}
                  onClick={() => setAutoPlay(!autoPlay)}
                  aria-label={autoPlay ? "Auto-advance on" : "Auto-advance off"}
                >
                  {autoPlay ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  type="button"
                  className="ss-icon-btn ss-icon-btn--loop"
                  data-active={looping || undefined}
                  onClick={() => setLooping(!looping)}
                  aria-label={looping ? "Loop on" : "Loop off"}
                >
                  <Repeat size={14} />
                </button>
                <button
                  type="button"
                  className="ss-icon-btn ss-icon-btn--speed"
                  onClick={cycleRate}
                  aria-label="Playback speed"
                >
                  <span className="ss-speed-display">{PLAYBACK_RATES[rateIdx]}x</span>
                </button>
              </>
            )}
            {phase !== "url-input" && (
              <button
                type="button"
                className="ss-icon-btn ss-icon-btn--close"
                onClick={handleReset}
                aria-label="New video"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>

        <div className="ss-card">
          {/* ── Video Player ── */}
          {shouldMountPlayer && (
            <div className="ss-player-wrap">
              <div id={PLAYER_ID} />
            </div>
          )}

          {/* ── Video Info ── */}
          {captions.meta && phase !== "url-input" && (
            <div className="ss-video-info">
              <Image
                className="ss-video-thumb"
                src={captions.meta.thumbnailUrl}
                alt=""
                width={80}
                height={45}
                unoptimized
              />
              <div>
                <div className="ss-video-title">{captions.meta.title}</div>
                <div className="ss-video-channel">{captions.meta.channelName}</div>
              </div>
            </div>
          )}

          {/* ── URL Input ── */}
          {phase === "url-input" && (
            <div className="ss-url-section ss-fade-in">
              <div className="ss-logo-icon" aria-hidden="true">
                <span className="ss-logo-play" />
              </div>
              <div className="ss-section-title">Learn with YouTube Subtitles</div>
              <div className="ss-url-desc">
                Paste a YouTube link to practice typing or speaking along with the official
                subtitles.
              </div>
              <div className="ss-desktop-notice">
                Desktop only — subtitles may not load on mobile devices.
              </div>
              <form className="ss-url-form" onSubmit={handleUrlSubmit}>
                <input
                  className="ss-url-input"
                  type="text"
                  placeholder="youtube.com/watch?v=..."
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  // biome-ignore lint/a11y/noAutofocus: intended for primary input on load
                  autoFocus
                />
                <button type="submit" className="ss-btn ss-btn-primary">
                  Go
                </button>
              </form>
              {recentVideos.length > 0 && (
                <div className="ss-recent-videos">
                  <div className="ss-recent-label">Recent</div>
                  {recentVideos.map((v) => (
                    <button
                      key={v.videoId}
                      type="button"
                      className="ss-recent-item"
                      onClick={() => {
                        setUrlInput(v.url);
                        setPhase("loading");
                        captions.fetchTracks(v.url);
                      }}
                    >
                      <Image
                        className="ss-recent-thumb"
                        src={v.thumbnailUrl}
                        alt=""
                        width={48}
                        height={27}
                        unoptimized
                      />
                      <div className="ss-recent-info">
                        <div className="ss-recent-title">{v.title}</div>
                        <div className="ss-recent-channel">{v.channelName}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Loading ── */}
          {phase === "loading" && (
            <div className="ss-loading ss-fade-in">
              <div className="ss-spinner" />
              <div className="ss-loading-text">Loading subtitles...</div>
            </div>
          )}

          {/* ── Error ── */}
          {phase === "error" && (
            <div className="ss-error-section ss-fade-in">
              <div className="ss-error-icon" aria-hidden="true" />
              <div className="ss-error-msg">
                {captions.error ??
                  "No captions available for this video. Try a video with subtitles (official or auto-generated)."}
              </div>
              <button type="button" className="ss-btn ss-btn-secondary" onClick={handleReset}>
                Try another video
              </button>
            </div>
          )}

          {/* ── Track Select ── */}
          {phase === "track-select" && captions.meta && (
            <div className="ss-fade-in">
              <div className="ss-section-title">Choose subtitle language</div>
              <div className="ss-section-label">
                {captions.meta.captionTracks.length} tracks available
              </div>
              <div className="ss-track-list">
                {captions.meta.captionTracks.map((track) => (
                  <button
                    key={`${track.languageCode}-${track.isAutoGenerated ? "auto" : "manual"}`}
                    type="button"
                    className="ss-track-btn"
                    onClick={() =>
                      handleTrackSelect(
                        track.languageCode,
                        track.isAutoGenerated ? "asr" : undefined,
                      )
                    }
                  >
                    <span className="ss-track-name">{track.name}</span>
                    <span className="ss-track-badge" data-auto={track.isAutoGenerated || undefined}>
                      {track.isAutoGenerated ? "auto" : track.languageCode}
                    </span>
                  </button>
                ))}
              </div>
              {captions.meta.captionTracks.some((t) => t.isAutoGenerated) && (
                <p className="ss-track-notice">
                  Auto-generated subtitles may be slightly out of sync with the video.
                </p>
              )}
            </div>
          )}

          {/* ── Mode Select ── */}
          {phase === "mode-select" && (
            <div className="ss-fade-in">
              <div className="ss-section-title">Choose practice mode</div>
              <div className="ss-section-label">
                {captions.cues.length} subtitle segments loaded
              </div>
              <div className="ss-mode-grid">
                <button
                  type="button"
                  className="ss-mode-btn ss-mode-btn--type"
                  onClick={() => handleModeSelect("type")}
                >
                  <span className="ss-mode-icon ss-mode-icon--type" aria-hidden="true" />
                  <div>
                    <div className="ss-mode-name">Type</div>
                    <div className="ss-mode-desc">
                      Type along with each subtitle. WPM &amp; accuracy tracked.
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  className="ss-mode-btn ss-mode-btn--speak"
                  onClick={() => handleModeSelect("speak")}
                >
                  <span className="ss-mode-icon ss-mode-icon--speak" aria-hidden="true" />
                  <div>
                    <div className="ss-mode-name">Speak</div>
                    <div className="ss-mode-desc">
                      Listen and repeat. Speech recognition checks pronunciation.
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  className="ss-mode-btn ss-mode-btn--fill"
                  onClick={() => handleModeSelect("fill")}
                >
                  <span className="ss-mode-icon ss-mode-icon--fill" aria-hidden="true" />
                  <div>
                    <div className="ss-mode-name">Fill</div>
                    <div className="ss-mode-desc">
                      Listen and fill in the missing words from each subtitle.
                    </div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* ── Practicing: Type Mode ── */}
          {phase === "practicing" && mode === "type" && currentCue && (
            <div className="ss-slide-up">
              <div className="ss-caption-area">
                <div className="ss-caption-label">subtitle</div>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: tap area wraps hidden input */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: tap area wraps hidden input */}
                <div className="ss-type-area" onClick={handleTapArea}>
                  <div className="ss-caption-text">
                    {Array.from(currentCue.text).map((char, idx) => {
                      const charState = typing.state.charStates[idx];
                      const state = charState == null ? "pending" : charState ? "correct" : "error";
                      const charKey = `c${activeCueIdx}-p${idx}`;
                      return (
                        <span key={charKey} className="ss-caption-char" data-state={state}>
                          {idx === typing.state.cursor &&
                            (composingText ? (
                              <span className="ss-composing">{composingText}</span>
                            ) : (
                              <span className="ss-cursor" />
                            ))}
                          {char}
                        </span>
                      );
                    })}
                    {typing.state.cursor === currentCue.text.length && !typing.state.done && (
                      <span className="ss-cursor" />
                    )}
                  </div>
                  {!typing.state.done && typing.state.cursor === 0 && (
                    <div className="ss-type-hint">Tap here and start typing</div>
                  )}
                  {typing.state.done && typing.state.accuracy === 100 && (
                    <div className="ss-type-hint">Tap or press any key to continue</div>
                  )}
                  {typing.state.done && typing.state.accuracy < 100 && (
                    <div className="ss-type-hint">Retry or skip to continue</div>
                  )}
                </div>
              </div>

              {typing.state.done && (
                <div className="ss-cue-result">
                  <div className="ss-cue-result-stats">
                    <span className="ss-cue-result-value">{typing.state.wpm}</span>
                    <span className="ss-cue-result-unit">WPM</span>
                    <span style={{ margin: "0 8px", color: "var(--ss-secondary)" }}>&middot;</span>
                    <span className="ss-cue-result-value">{typing.state.accuracy}%</span>
                  </div>
                  <div className="ss-cue-result-label">
                    {typing.state.accuracy >= 90
                      ? "Excellent!"
                      : typing.state.accuracy >= 70
                        ? "Good job!"
                        : "Keep practicing!"}
                  </div>
                  {typing.state.accuracy < 100 && (
                    <div className="ss-cue-retry-actions">
                      <button
                        type="button"
                        className="ss-btn ss-btn-secondary"
                        style={{ flex: 1 }}
                        onClick={retryCue}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        className="ss-btn ss-btn-primary"
                        style={{ flex: 1 }}
                        onClick={advanceCue}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              )}

              <input
                ref={inputRef}
                className="ss-hidden-input"
                type="text"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                value={typingInputValue}
                maxLength={currentCue.text.normalize("NFC").length}
                onInput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  setTypingInputValue(val);
                  typing.handleInput(val);
                }}
                onCompositionStart={() => {
                  typing.handleCompositionStart();
                  setComposingText("");
                }}
                onCompositionUpdate={(e) => {
                  setComposingText(e.data);
                }}
                onCompositionEnd={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  setTypingInputValue(val);
                  setComposingText("");
                  typing.handleCompositionEnd(val);
                }}
                onChange={() => {}}
              />
            </div>
          )}

          {/* ── Practicing: Speak Mode ── */}
          {phase === "practicing" && mode === "speak" && currentCue && (
            <div className="ss-slide-up">
              <div className="ss-caption-area">
                <div className="ss-caption-label">listen &amp; repeat</div>
                <div className="ss-caption-text">{currentCue.text}</div>
              </div>

              <div className="ss-speak-area">
                <button
                  type="button"
                  className="ss-mic-btn"
                  data-active={isListening || undefined}
                  onClick={toggleListening}
                  aria-label="Microphone"
                />
                {spokenText && (
                  <div className="ss-speak-result">
                    &ldquo;{spokenText}&rdquo;
                    {speakAccuracy !== null && (
                      <span
                        style={{
                          marginLeft: 8,
                          color: speakAccuracy >= 80 ? "var(--ss-correct)" : "var(--ss-error)",
                          fontWeight: 600,
                        }}
                      >
                        {speakAccuracy}%
                      </span>
                    )}
                  </div>
                )}
                {!spokenText && !isListening && (
                  <div className="ss-speak-result">
                    Tap the mic, listen, then speak the subtitle
                  </div>
                )}
                {isListening && <div className="ss-speak-result">Listening...</div>}
              </div>
            </div>
          )}

          {/* ── Practicing: Fill Mode ── */}
          {phase === "practicing" && mode === "fill" && currentCue && fillData && (
            <div className="ss-slide-up">
              <div className="ss-caption-area">
                <div className="ss-caption-label">fill the blanks</div>
                <div className="ss-caption-text">
                  {fillData.words.map((word, idx) => {
                    const isBlank = fillData.blankIndices.has(idx);
                    const wordKey = `${activeCueIdx}-${isBlank ? "b" : "w"}${idx}`;
                    if (!isBlank) {
                      return (
                        <span key={wordKey} className="ss-fill-word">
                          {word}{" "}
                        </span>
                      );
                    }
                    const blankResult = fillBlankResults.find((r) => r.blankIndex === idx);
                    return (
                      <span
                        key={wordKey}
                        className="ss-fill-blank"
                        data-revealed={fillRevealed || undefined}
                        data-correct={(fillRevealed && blankResult?.correct) || undefined}
                        data-wrong={
                          (fillRevealed && blankResult && !blankResult.correct) || undefined
                        }
                      >
                        {word}
                        {fillRevealed && blankResult && !blankResult.correct && (
                          <span className="ss-fill-user-answer">
                            {blankResult.userAnswer || "?"}
                          </span>
                        )}{" "}
                      </span>
                    );
                  })}
                </div>
              </div>

              {!fillRevealed && (
                <form onSubmit={handleFillSubmit}>
                  <input
                    ref={fillInputRef}
                    className="ss-fill-input"
                    type="text"
                    placeholder="Type the missing words..."
                    value={fillInput}
                    onChange={(e) => setFillInput(e.target.value)}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <button
                    type="submit"
                    className="ss-btn ss-btn-primary ss-btn-full"
                    style={{ marginTop: 8 }}
                  >
                    Check
                  </button>
                </form>
              )}

              {fillRevealed && (
                <div className="ss-cue-result">
                  <div className="ss-cue-result-stats">
                    <span className="ss-cue-result-value">
                      {results[results.length - 1]?.accuracy ?? 0}%
                    </span>
                  </div>
                  <div className="ss-cue-result-label">
                    {(results[results.length - 1]?.accuracy ?? 0) >= 80
                      ? "Nice!"
                      : "Review the answer above"}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Controls (during practice) ── */}
          {phase === "practicing" && (
            <>
              <div className="ss-progress-bar">
                <div className="ss-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="ss-controls">
                <span className="ss-ctrl-slot">
                  {activeCueIdx > 0 && (
                    <button
                      type="button"
                      className="ss-ctrl-btn"
                      onClick={prevCue}
                      title="Previous"
                    >
                      &#x21E4; Prev
                    </button>
                  )}
                </span>
                <span className="ss-cue-counter">
                  {activeCueIdx + 1} / {captions.cues.length}
                </span>
                <span className="ss-ctrl-slot ss-ctrl-slot--end">
                  {activeCueIdx < captions.cues.length - 1 && (
                    <button type="button" className="ss-ctrl-btn" onClick={skipCue} title="Skip">
                      Skip &#x21E5;
                    </button>
                  )}
                </span>
              </div>
            </>
          )}

          {/* ── Session Done ── */}
          {phase === "session-done" && (
            <div className="ss-done-section ss-fade-in">
              <div className="ss-done-icon" aria-hidden="true" />
              <div className="ss-done-title">Session Complete!</div>

              <div className="ss-summary-grid">
                <div className="ss-summary-item">
                  <div className="ss-summary-value">{sessionStats.completed}</div>
                  <div className="ss-summary-label">Completed</div>
                </div>
                <div className="ss-summary-item">
                  <div className="ss-summary-value">{sessionStats.skipped}</div>
                  <div className="ss-summary-label">Skipped</div>
                </div>
                <div className="ss-summary-item">
                  <div
                    className="ss-summary-value"
                    data-accuracy={
                      sessionStats.avgAccuracy >= 90
                        ? "gold"
                        : sessionStats.avgAccuracy >= 70
                          ? "green"
                          : undefined
                    }
                  >
                    {sessionStats.avgAccuracy}%
                  </div>
                  <div className="ss-summary-label">Accuracy</div>
                </div>
                {mode === "type" && (
                  <div className="ss-summary-item">
                    <div className="ss-summary-value">{sessionStats.avgWpm}</div>
                    <div className="ss-summary-label">Avg WPM</div>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, width: "100%" }}>
                <button
                  type="button"
                  className="ss-btn ss-btn-secondary"
                  style={{ flex: 1 }}
                  onClick={handleReset}
                >
                  New Video
                </button>
                <button
                  type="button"
                  className="ss-btn ss-btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setActiveCueIdx(0);
                    setResults([]);
                    setPhase("mode-select");
                  }}
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
