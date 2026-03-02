"use client";

import { useCallback, useRef, useState } from "react";

export interface TypingState {
  cursor: number;
  charStates: (boolean | null)[];
  done: boolean;
  wpm: number;
  accuracy: number;
}

interface TypingCallbacks {
  onCharCorrect?: () => void;
  onCharError?: () => void;
  onComplete?: (wpm: number, accuracy: number) => void;
}

export function useTypingEngine(callbacks?: TypingCallbacks) {
  const [state, setState] = useState<TypingState>({
    cursor: 0,
    charStates: [],
    done: false,
    wpm: 0,
    accuracy: 0,
  });

  const targetRef = useRef("");
  const startTimeRef = useRef(0);
  const composingRef = useRef(false);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const start = useCallback((target: string) => {
    targetRef.current = target.normalize("NFC");
    startTimeRef.current = 0;
    composingRef.current = false;
    setState({
      cursor: 0,
      charStates: new Array(target.normalize("NFC").length).fill(null),
      done: false,
      wpm: 0,
      accuracy: 0,
    });
  }, []);

  const handleInput = useCallback((inputValue: string) => {
    if (composingRef.current) return;

    const normalized = inputValue.normalize("NFC");
    const target = targetRef.current;

    if (startTimeRef.current === 0 && normalized.length > 0) {
      startTimeRef.current = performance.now();
    }

    const newStates: (boolean | null)[] = new Array(target.length).fill(null);
    for (let i = 0; i < normalized.length && i < target.length; i++) {
      const isCorrect = normalized[i] === target[i];
      newStates[i] = isCorrect;
      if (isCorrect) {
        callbacksRef.current?.onCharCorrect?.();
      } else {
        callbacksRef.current?.onCharError?.();
      }
    }

    const cursor = Math.min(normalized.length, target.length);

    if (cursor >= target.length) {
      const elapsed = (performance.now() - startTimeRef.current) / 1000;
      const words = target.length / 5;
      const wpm = elapsed > 0 ? Math.round((words / elapsed) * 60) : 0;
      const correctCount = newStates.filter((s) => s === true).length;
      const accuracy = target.length > 0 ? Math.round((correctCount / target.length) * 100) : 100;

      callbacksRef.current?.onComplete?.(wpm, accuracy);
      setState({ cursor, charStates: newStates, done: true, wpm, accuracy });
      return;
    }

    setState({ cursor, charStates: newStates, done: false, wpm: 0, accuracy: 0 });
  }, []);

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (inputValue: string) => {
      composingRef.current = false;
      handleInput(inputValue);
    },
    [handleInput],
  );

  const reset = useCallback(() => {
    const target = targetRef.current;
    startTimeRef.current = 0;
    composingRef.current = false;
    setState({
      cursor: 0,
      charStates: new Array(target.length).fill(null),
      done: false,
      wpm: 0,
      accuracy: 0,
    });
  }, []);

  return { state, start, handleInput, handleCompositionStart, handleCompositionEnd, reset };
}
