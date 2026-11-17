// Browser APIs jsdom leaves out, which bb's own components use: the media
// queries behind the phone layout, and the observer popovers measure with.
if (typeof window !== "undefined") {
  if (typeof window.matchMedia !== "function")
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  if (typeof window.ResizeObserver !== "function")
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
}
