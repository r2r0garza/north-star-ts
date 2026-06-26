/// <reference types="vite/client" />

import type { CoworkApi } from "../../preload/index"

// The preload bridge exposes `window.cowork` to the renderer.
declare global {
  interface Window {
    cowork: CoworkApi
  }
}

export {}
