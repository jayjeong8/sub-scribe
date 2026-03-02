"use client";

import { useCallback, useMemo, useState } from "react";
import type { CaptionCue, CaptionTrack, VideoMeta } from "../_lib/types";

interface CaptionsState {
  loading: boolean;
  error: string | null;
  meta: VideoMeta | null;
  cues: CaptionCue[];
  selectedLang: string | null;
}

export function useCaptions() {
  const [state, setState] = useState<CaptionsState>({
    loading: false,
    error: null,
    meta: null,
    cues: [],
    selectedLang: null,
  });

  /** Fetch video metadata + available caption tracks */
  const fetchTracks = useCallback(async (videoIdOrUrl: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null, meta: null, cues: [] }));

    try {
      const res = await fetch(`/api/captions?v=${encodeURIComponent(videoIdOrUrl)}`, {
        cache: "no-cache",
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to load video info");
      }

      const meta: VideoMeta = {
        videoId: data.videoId,
        title: data.title,
        channelName: data.channelName,
        thumbnailUrl: data.thumbnailUrl,
        captionTracks: data.captionTracks as CaptionTrack[],
      };

      if (meta.captionTracks.length === 0) {
        const errorMsg =
          meta.title === "Unknown"
            ? "Could not load video info. Try again in a moment."
            : `No captions available for "${meta.title}". Try a video with subtitles.`;
        setState({
          loading: false,
          error: errorMsg,
          meta,
          cues: [],
          selectedLang: null,
        });
        return;
      }

      setState({
        loading: false,
        error: null,
        meta,
        cues: [],
        selectedLang: null,
      });
    } catch (err) {
      setState({
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load video",
        meta: null,
        cues: [],
        selectedLang: null,
      });
    }
  }, []);

  /** Fetch caption cues for a specific language */
  const fetchCues = useCallback(
    async (lang: string, kind?: string) => {
      if (!state.meta) return;

      setState((prev) => ({ ...prev, loading: true, error: null, selectedLang: lang }));

      try {
        let url = `/api/captions?v=${encodeURIComponent(state.meta.videoId)}&lang=${encodeURIComponent(lang)}`;
        if (kind) url += `&kind=${encodeURIComponent(kind)}`;
        const res = await fetch(url, { cache: "no-cache" });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error ?? "Failed to load captions");
        }

        const cues: CaptionCue[] = (data.cues ?? []).map(
          (c: { start: number; duration: number; end: number; text: string }) => ({
            start: c.start,
            duration: c.duration,
            end: c.end,
            text: c.text,
          }),
        );

        setState((prev) => ({
          ...prev,
          loading: false,
          cues,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load captions",
        }));
      }
    },
    [state.meta],
  );

  /** Find the current cue based on playback time */
  const findCueAtTime = useCallback(
    (time: number): number => {
      for (let i = 0; i < state.cues.length; i++) {
        const cue = state.cues[i];
        if (time >= cue.start && time < cue.end) return i;
      }
      // If between cues, find the next upcoming cue
      for (let i = 0; i < state.cues.length; i++) {
        if (state.cues[i].start > time) return i - 1 >= 0 ? i - 1 : -1;
      }
      return state.cues.length > 0 ? state.cues.length - 1 : -1;
    },
    [state.cues],
  );

  const reset = useCallback(() => {
    setState({
      loading: false,
      error: null,
      meta: null,
      cues: [],
      selectedLang: null,
    });
  }, []);

  return useMemo(
    () => ({
      ...state,
      fetchTracks,
      fetchCues,
      findCueAtTime,
      reset,
    }),
    [state, fetchTracks, fetchCues, findCueAtTime, reset],
  );
}
