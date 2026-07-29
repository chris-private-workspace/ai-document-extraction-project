import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

const nextConfig: NextConfig = {
  // Enable React strict mode for better development experience
  reactStrictMode: true,

  // Production output mode: standalone
  // Required for Docker deployment to Azure Container Apps (CHANGE-055 Phase 2)
  // Generates .next/standalone/ with minimal node_modules + server.js
  // Reference: docs/06-deployment/02-azure-deployment/uat-deployment/04-container-build-push.md (Action 4.2)
  output: 'standalone',

  // re2-wasm（FIX-069 safe-regex 引擎）必須從 node_modules 載入，不可被 webpack bundle。
  // 其 emscripten glue 以 readFileSync(__dirname + '/re2.wasm') 動態載入 wasm;一旦被 bundle 進
  // .next/server/chunks，__dirname 變成 chunks 目錄而找不到 re2.wasm（runtime ENOENT）。
  // 標為 external → require 回 node_modules，__dirname 指向真實套件目錄找到 re2.wasm。
  // 搭配 Dockerfile 將 node_modules/re2-wasm 複製進 runner（含 build/wasm/re2.wasm）。
  // FIX-083: pdfkit 同理——它在 route handler 是「靜態 import」，Next 15 App Router 預設會
  // 把它打包進 .next/server/vendor-chunks/，其 fs.readFileSync(__dirname + '/data/*.afm') 便
  // 指向 bundle 目錄而 ENOENT Helvetica.afm（本地 dev 與 Azure standalone 皆然）。手動 webpack
  // externals 對「靜態 import 的 route handler 依賴」無效（只對 pdf-to-img 那種 await import()
  // 動態載入有效），serverExternalPackages 才是 App Router 的正解。搭配 FIX-081 Dockerfile 的
  // COPY node_modules/pdfkit（standalone trace 不含 .afm 資產檔）。
  // CHANGE-113: @napi-rs/canvas 同理。它是 native 套件（skia.*.node），webpack 沒有
  // 對應 loader，掃到就會 "Module parse failed: Unexpected character"。
  // 先前它只被 pdf-to-img 內部 require，而 pdf-to-img 已列在下方 webpack externals，
  // 所以 webpack 從未追到它；階段一 A 改為由 pdf-converter 直接 await import()，
  // 打包器便開始追進 node_modules 的 .node 二進位檔而 build 失敗。
  // Dockerfile 已 COPY @napi-rs/canvas 與其 linux-x64-gnu prebuilt（FIX-080），runtime 找得到。
  serverExternalPackages: ['re2-wasm', 'pdfkit', '@napi-rs/canvas'],

  // ESLint configuration for build
  // Note: Warnings are treated as errors in production build by default
  // Setting ignoreDuringBuilds to allow build with warnings (temporary for testing)
  eslint: {
    // Warning: This allows production builds to successfully complete even if
    // your project has ESLint errors. These should be fixed before production.
    ignoreDuringBuilds: true,
  },

  // Configure image domains if needed
  images: {
    remotePatterns: [],
  },

  // Experimental features
  experimental: {
    // Enable server actions
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },

  // Webpack configuration
  // FIX-026: 降級到 react-pdf v9 + pdfjs-dist v4 以避免 ESM 問題
  // pdfjs-dist v5.4.x 的 ESM 模組與 webpack eval-based source maps 不兼容
  //
  // 參考:
  // - https://github.com/mozilla/pdf.js/issues/20478
  // - https://github.com/wojtekmaj/react-pdf/issues/1813
  webpack: (config, { isServer }) => {
    // Client-side: disable canvas (not available in browser)
    if (!isServer) {
      config.resolve.alias.canvas = false
    }

    // Mark native modules and PDF libraries as external for server to avoid bundling issues
    // pg-native: optional C++ libpq binding (pg fallback to pure JS when not installed)
    if (isServer) {
      config.externals = config.externals || []
      config.externals.push({
        canvas: 'commonjs canvas',
        'pdf-to-img': 'commonjs pdf-to-img',
        'pdfjs-dist': 'commonjs pdfjs-dist',
        'pg-native': 'commonjs pg-native',
      })
    }

    return config
  },
}

export default withNextIntl(nextConfig)
