/** @type {import('next').NextConfig} */
const nextConfig = {
  // Performance optimizations
  experimental: {
    // Use SWC compiler for better performance
    forceSwcTransforms: true,
  },
  
  // Skip type checking during build (handled separately)
  typescript: {
    ignoreBuildErrors: true,
  },
  
  // Output file tracing for smaller bundles
  outputFileTracingRoot: __dirname,
  
  // External packages for server components
  serverExternalPackages: ['playwright', 'chrome-launcher', 'chrome-remote-interface'],
  
  // Compiler optimizations
  compiler: {
    // Keep console.log for debugging in production
    removeConsole: false,
  },
  
  // Bundle optimization
  webpack: (config, { buildId, dev, isServer, defaultLoaders, webpack }) => {
    // Optimize bundle size
    if (!dev && !isServer) {
      // Bundle analyzer in production builds
      if (process.env.ANALYZE === 'true') {
        const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
        config.plugins.push(
          new BundleAnalyzerPlugin({
            analyzerMode: 'static',
            reportFilename: './analyze/bundle-report.html',
            openAnalyzer: false,
          })
        );
      }
    }
    
    // External dependencies that shouldn't be bundled for browser
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        path: false,
        os: false,
        stream: false,
        util: false,
      };
    }
    
    // Optimize heavy dependencies
    config.resolve.alias = {
      ...config.resolve.alias,
      // Use date-fns instead of moment for smaller bundle
      'moment': 'date-fns',
    };
    
    return config;
  },
  
  // Output optimization
  output: 'standalone',
  
  // Compression
  compress: true,
  
  // Headers for better caching and performance
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=300, s-maxage=600', // 5 min cache, 10 min edge cache
          },
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on'
          },
        ],
      },
    ];
  },
  
  // Performance monitoring
  onDemandEntries: {
    // Period (in ms) where the server will keep pages in the buffer
    maxInactiveAge: 25 * 1000,
    // Number of pages that should be kept simultaneously without being disposed
    pagesBufferLength: 2,
  },
  
  // Image optimization (if using images)
  images: {
    formats: ['image/webp', 'image/avif'],
    minimumCacheTTL: 60,
  },
  
  // Production optimizations
  ...(process.env.NODE_ENV === 'production' && {
    // Enable gzip compression
    compress: true,
  }),
};

module.exports = nextConfig;