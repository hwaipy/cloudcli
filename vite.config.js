import { statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// The client shows the installed package version so it can be compared against the
// version the server process is actually running. Reading package.json here and
// injecting it keeps the frontend free of imports that reach outside src/.
const pkg = createRequire(import.meta.url)('./package.json')

// Publish the initial static graph and its decoded byte sizes for the tiny boot entry.
let bootFiles = []
const bootAssetsPlugin = {
  name: 'boot-assets',
  apply: 'build',
  generateBundle(_options, bundle) {
    const entry = Object.values(bundle).find(item =>
      item.type === 'chunk' && Object.keys(item.modules).some(id => id.endsWith('/src/main.tsx'))
    )
    if (!entry) throw new Error('Could not find the CloudCLI application entry')

    const files = new Set()
    const visit = fileName => {
      if (files.has(fileName)) return
      const item = bundle[fileName]
      if (!item || item.type !== 'chunk') return
      files.add(fileName)
      for (const imported of item.imports) visit(imported)
      for (const css of item.viteMetadata?.importedCss || []) files.add(css)
    }
    visit(entry.fileName)

    bootFiles = [...files]
  },
  writeBundle(options) {
    if (!options.dir) throw new Error('Boot assets need an output directory')
    // Vite may change JS/CSS after generateBundle; measure the written files.
    const assets = bootFiles.map(file => ({ file, bytes: statSync(join(options.dir, file)).size }))
    writeFileSync(join(options.dir, 'boot-assets.json'), JSON.stringify({ assets }))
  },
}

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    base: '/',
    plugins: [react(), bootAssetsPlugin],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    }
  }
})
