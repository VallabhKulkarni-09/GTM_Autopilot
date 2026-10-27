import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  // Pin the tracing root to this folder: the repo has two package-lock.json files
  // (API + dashboard) which otherwise confuse Next.js workspace-root detection.
  // The dashboard imports nothing from outside this folder.
  outputFileTracingRoot: path.join(__dirname),
  // Self-contained server bundle for the Docker image (dashboard/Dockerfile).
  output: 'standalone',
}
export default nextConfig
