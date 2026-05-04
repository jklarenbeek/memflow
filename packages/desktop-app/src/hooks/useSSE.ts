/**
 * useSSE — Generic Server-Sent Events hook with reconnection
 */
import { useEffect, useRef, useState, useCallback } from "react";

interface UseSSEOptions<T> {
  onMessage: (event: T) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
  reconnectInterval?: number;
  maxRetries?: number;
  enabled?: boolean;
}

export function useSSE<T = unknown>(url: string | null, options: UseSSEOptions<T>) {
  const {
    onMessage, onError, onOpen,
    reconnectInterval = 3000, maxRetries = 5, enabled = true,
  } = options;

  const [connected, setConnected] = useState(false);
  const [retries, setRetries] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);
  const retriesRef = useRef(retries);
  retriesRef.current = retries;

  const close = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setConnected(false);
  }, []);

  useEffect(() => {
    if (!url || !enabled) return;

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
      setRetries(0);
      onOpen?.();
    };

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as T;
        onMessage(data);
      } catch {
        // Non-JSON messages are ignored
      }
    };

    source.onerror = (event) => {
      setConnected(false);
      onError?.(event);

      if (retriesRef.current < maxRetries) {
        setTimeout(() => {
          setRetries((r) => r + 1);
        }, reconnectInterval * Math.pow(2, retriesRef.current));
      }
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [url, enabled, retries]);

  return { connected, close, retries };
}
