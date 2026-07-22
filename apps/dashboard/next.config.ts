import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@affiliate/database",
    "@affiliate/shared",
    "@affiliate/scoring",
    "@affiliate/validation",
  ],
};

export default nextConfig;
