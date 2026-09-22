import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    // Transcripts are uploaded as multipart bodies; a 25 MB file needs headroom.
    serverActions: { bodySizeLimit: '32mb' },
  },
};

export default nextConfig;
