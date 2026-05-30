/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@clawreview/ui', '@clawreview/types'],
  experimental: {
    typedRoutes: true,
  },
  webpack: (config) => {
    // The workspace UI/types packages are pure TS source with .js import
    // specifiers (ESM NodeNext style). Teach webpack to resolve .js to .ts.
    config.resolve = config.resolve || {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
