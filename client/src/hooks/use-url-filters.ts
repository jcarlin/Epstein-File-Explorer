import { useState, useCallback, useEffect, useRef } from "react";
import { useSearch } from "wouter";

type FilterConfig = Record<string, string>;

/**
 * Syncs filter state with URL search params.
 * On mount, reads initial values from URL. On change, updates URL via replaceState.
 * Reacts to wouter navigation (pushState) via useSearch().
 */
export function useUrlFilters<T extends FilterConfig>(defaults: T): [T, (key: keyof T, value: string) => void, () => void] {
  const defaultsRef = useRef(defaults);
  const search = useSearch();

  const readFromUrl = useCallback((): T => {
    const params = new URLSearchParams(window.location.search);
    const result = { ...defaultsRef.current };
    for (const key of Object.keys(result)) {
      const urlVal = params.get(key);
      if (urlVal !== null) {
        (result as FilterConfig)[key] = urlVal;
      }
    }
    return result;
  }, []);

  const [filters, setFilters] = useState<T>(readFromUrl);

  const writeToUrl = useCallback((updated: T) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(updated)) {
      if (value && value !== defaultsRef.current[key]) {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    const newUrl = window.location.pathname + (qs ? `?${qs}` : "");
    window.history.replaceState(null, "", newUrl);
  }, []);

  const setFilter = useCallback((key: keyof T, value: string) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value };
      writeToUrl(next);
      return next;
    });
  }, [writeToUrl]);

  const resetFilters = useCallback(() => {
    const next = { ...defaultsRef.current };
    setFilters(next);
    writeToUrl(next);
  }, [writeToUrl]);

  // Re-read URL when wouter navigates (pushState) or browser back/forward (popstate)
  useEffect(() => {
    setFilters(readFromUrl());
  }, [search, readFromUrl]);

  return [filters, setFilter, resetFilters];
}
