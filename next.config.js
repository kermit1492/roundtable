/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel serverless functions timeout (Pro plan: up to 300s)
  // Free plan: 10s for Hobby, which may not be enough for AI discussions
  // Consider upgrading to Pro for longer timeouts
}

module.exports = nextConfig
