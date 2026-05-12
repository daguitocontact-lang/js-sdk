import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'voice/index': 'src/voice/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  // Source maps disabled on publish — `.map` files ship the original TS
  // source, which would expose proprietary client logic to anyone who
  // unpacks the tarball. Keep stack traces minified for SDK consumers.
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  // Keep voice as a separate entry so consumers who don't import it get
  // a smaller bundle and tree-shaking strips it cleanly.
  outDir: 'dist',
})
