# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install build-time native deps (argon2 requires g++ make python3).
# The C toolchain lives ONLY in this stage — never in the runtime image.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./

# Full install (needs devDeps for tsc; argon2 native addon is compiled here)
RUN npm ci

COPY prisma ./prisma
# Generate the Prisma client (must happen before tsc so generated types are available)
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/
RUN npm run build

# Strip devDependencies; the resulting node_modules (with the compiled argon2
# addon and the prisma CLI, which is a production dependency) is copied into
# the runtime stage as-is.
RUN npm prune --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
# IMPORTANT: must be the SAME base image/version as the builder. The argon2
# native addon compiled there is ABI-sensitive (Node ABI + musl libc); copying
# it instead of rebuilding only works if builder and runtime match exactly.
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Entrypoint wrapper (runs migrations then the chosen service).
# Installed by root with exec bit; the app itself runs as `node` below.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Production node_modules come pre-built from the builder — no compiler,
# no `npm install`, no npm self-update in the runtime image.
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Prisma schema + migrations (needed by `prisma migrate deploy` at startup)
COPY --chown=node:node prisma ./prisma

# Compiled output
COPY --from=builder --chown=node:node /app/dist ./dist

# Drop privileges: run as the unprivileged `node` user shipped with the base image
USER node

# Regenerate the Prisma client in-place (npm prune may drop the generated
# client under node_modules/.prisma; the prisma CLI is available locally).
RUN npx prisma generate

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
# Default: start the HTTP server; override CMD to "worker" for the worker service
CMD ["server"]
