import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'voice/index': 'src/voice/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  // Keep voice as a separate entry so consumers who don't import it get
  // a smaller bundle and tree-shaking strips it cleanly.
  outDir: 'dist',
})
