import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  root: 'src',
  publicDir: resolve(__dirname, 'public'),
  server: {
    port: 1430,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  optimizeDeps: {
    // Exclude only the wasm runtimes — esbuild pre-bundling mangles their wasm
    // loading. The OCR lib (@gutenye/ocr-browser) MUST stay pre-bundled so its
    // CommonJS deps (e.g. js-clipper) get proper CJS→ESM default-export interop.
    exclude: ['@huggingface/transformers', 'onnxruntime-web'],
  },
  // Ensure a single onnxruntime-web instance so the OCR worker's env config
  // (wasmPaths / single-thread) applies to the copy @gutenye/ocr-browser uses.
  resolve: {
    dedupe: ['onnxruntime-web'],
  },
})
