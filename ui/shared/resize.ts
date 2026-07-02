export function notifyHostAboutResize(): void {
  globalThis.requestAnimationFrame(() => {
    globalThis.dispatchEvent(new Event('resize'));
  });
}
