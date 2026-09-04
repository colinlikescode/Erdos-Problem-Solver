import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  distDir: "out",
  images: { unoptimized: true },
  devIndicators: false,
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
