/// <reference types="vite/client" />

declare module '*?raw' {
  const content: string;
  export default content;
}

/** The git commit the page was built from ('' when unknown); vite.config.ts */
declare const __BUILD_SHA__: string;

/** This build's own copy of the Blink engine, e.g. 'engines/blink/v-0123456789ab/' ('' in dev); vite-plugin-engines.ts */
declare const __BLINK_ENGINE_DIR__: string;
