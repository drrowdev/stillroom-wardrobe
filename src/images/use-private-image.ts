import { useEffect, useRef, useState } from 'react';
import type { PrivateImages } from './private-images';
import { isAborted } from '../data/errors';

export function usePrivateImage(images: PrivateImages, path: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ images: PrivateImages; path: string; url: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    let active = true, admitted = false;
    let observer: IntersectionObserver | null = null;
    const unsubscribe = images.subscribe(paths => {
      if (!paths.includes(path)) return;
      active = false; observer?.disconnect();
      setResult({ images, path, url: null, failed: true });
    });
    const admit = () => {
      if (!active || admitted) return;
      admitted = true; observer?.disconnect();
      void images.get(path).then(url => {
        if (active) setResult({ images, path, url, failed: false });
      }, (error: unknown) => {
        if (active && !isAborted(error)) setResult({ images, path, url: null, failed: true });
      });
    };
    if (typeof IntersectionObserver === 'undefined') admit();
    else {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) admit();
      }, { rootMargin: '200px 0px' });
      if (ref.current) observer.observe(ref.current);
    }
    return () => { active = false; observer?.disconnect(); unsubscribe(); };
  }, [images, path]);
  const current = result?.images === images && result.path === path ? result : null;
  return { ref, url: current?.url ?? null, failed: current?.failed ?? false };
}
