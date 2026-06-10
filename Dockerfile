# Docker build for Railway. Uses a Docker Hub base image (node:20) instead of
# Railway's nixpacks builder image from ghcr.io, which sidesteps the intermittent
# ghcr.io 502s that were failing GitHub-source builds.

FROM node:20-bookworm-slim

# Build toolchain for native modules. better-sqlite3 falls back to compiling if no
# prebuilt binary matches the ABI; sharp ships its own prebuilt libvips.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL deps first (cached layer). NODE_ENV must NOT be production here, or
# npm would skip the devDeps (vite/tsc) the build needs. Host node_modules are
# kept out by .dockerignore so the linux-native bindings aren't clobbered.
COPY package.json package-lock.json ./
RUN npm ci

# App source + production build (vite client + tsc server). `vite build` defaults
# to production mode regardless of NODE_ENV.
COPY . .
RUN npm run build

# Now lock to production and drop devDeps; compiled native bindings for the prod
# deps (better-sqlite3, sharp) stay in place.
ENV NODE_ENV=production
RUN npm prune --omit=dev

# Railway injects $PORT at runtime; the server reads process.env.PORT.
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
