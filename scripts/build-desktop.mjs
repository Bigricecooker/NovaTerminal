import { build } from 'esbuild'

await build({
  entryPoints: { main: 'src/main/index.ts', preload: 'src/preload/index.ts', 'session-worker': 'src/main/session-worker.ts' },
  outdir: 'out/electron', outExtension: { '.js': '.cjs' },
  platform: 'node', format: 'cjs', bundle: true, packages: 'external', target: 'node22',
  sourcemap: false, logLevel: 'info',
})
