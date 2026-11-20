import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // The API contracts are published as TypeScript sources.
  transpilePackages: ["@aep/contracts"],
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          // The approve and cancel buttons must not be clickable inside another site's frame.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ]);
  },
};

export default config;
