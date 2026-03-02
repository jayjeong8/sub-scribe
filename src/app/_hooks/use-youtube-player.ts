"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Minimal type for the YouTube IFrame API player */
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  destroy(): void;
}

interface YTPlayerEvent {
  data: number;
  target: YTPlayer;
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: string | HTMLElement,
        config: {
          videoId: string;
          playerVars?: Record<string, number | string>;
          events?: {
            onReady?: (e: { target: YTPlayer }) => void;
            onStateChange?: (e: YTPlayerEvent) => void;
          };
        },
      ) => YTPlayer;
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export type PlayerState = "unstarted" | "playing" | "paused" | "buffering" | "ended";

interface UseYouTubePlayerOptions {
  containerId: string;
  videoId: string;
  onTimeUpdate?: (time: number) => void;
  onStateChange?: (state: PlayerState) => void;
}

function mapState(data: number): PlayerState {
  switch (data) {
    case 1:
      return "playing";
    case 2:
      return "paused";
    case 3:
      return "buffering";
    case 0:
      return "ended";
    default:
      return "unstarted";
  }
}

let apiLoading = false;
let apiLoaded = false;
const apiCallbacks: (() => void)[] = [];

function ensureYTAPI(): Promise<void> {
  if (apiLoaded && window.YT) return Promise.resolve();

  return new Promise<void>((resolve) => {
    apiCallbacks.push(resolve);

    if (apiLoading) return;
    apiLoading = true;

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      apiLoaded = true;
      for (const cb of apiCallbacks) cb();
      apiCallbacks.length = 0;
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
}

export function useYouTubePlayer({
  containerId,
  videoId,
  onTimeUpdate,
  onStateChange,
}: UseYouTubePlayerOptions) {
  const playerRef = useRef<YTPlayer | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callbacksRef = useRef({ onTimeUpdate, onStateChange });
  callbacksRef.current = { onTimeUpdate, onStateChange };

  const [ready, setReady] = useState(false);
  const [playerState, setPlayerState] = useState<PlayerState>("unstarted");
  const [currentTime, setCurrentTime] = useState(0);

  // Start polling current time when playing
  const startPolling = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      const t = p.getCurrentTime();
      setCurrentTime(t);
      callbacksRef.current.onTimeUpdate?.(t);
    }, 100); // 100ms interval for smooth sync
  }, []);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Initialize player
  useEffect(() => {
    let destroyed = false;

    ensureYTAPI().then(() => {
      if (destroyed) return;
      if (!window.YT) return;

      const player = new window.YT.Player(containerId, {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          modestbranding: 1,
          rel: 0,
          cc_load_policy: 0, // Don't auto-show YT captions
          iv_load_policy: 3, // No annotations
          playsinline: 1,
        },
        events: {
          onReady: () => {
            if (destroyed) return;
            playerRef.current = player;
            setReady(true);
          },
          onStateChange: (e: YTPlayerEvent) => {
            if (destroyed) return;
            const state = mapState(e.data);
            setPlayerState(state);
            callbacksRef.current.onStateChange?.(state);

            if (state === "playing") {
              startPolling();
            } else {
              stopPolling();
            }
          },
        },
      });
    });

    return () => {
      destroyed = true;
      stopPolling();
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [containerId, videoId, startPolling, stopPolling]);

  const play = useCallback(() => playerRef.current?.playVideo(), []);
  const pause = useCallback(() => playerRef.current?.pauseVideo(), []);

  const seekTo = useCallback((seconds: number) => {
    playerRef.current?.seekTo(seconds, true);
    setCurrentTime(seconds);
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    playerRef.current?.setPlaybackRate(rate);
  }, []);

  return {
    ready,
    playerState,
    currentTime,
    play,
    pause,
    seekTo,
    setPlaybackRate,
  };
}
