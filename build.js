const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/engine/AntigravityEngine.ts'],
  bundle: true,
  outfile: 'dist/AntigravityEngine.bundle.js',
  format: 'iife',
  globalName: 'AntigravityCore',
  target: ['chrome100'],
  minify: false, // Keep readable for debugging
  sourcemap: true,
}).catch(() => process.exit(1));
