# One image serving both apps from a single origin: backend/'s Next.js
# server answers /api/* and serves frontend/'s SPA build for everything else
# (see backend/next.config.ts's SERVE_FRONTEND and frontend/vite.config.ts's
# FRONTEND_SPA_BUILD).
#
#   docker build -t faceoff-brackets .
#   docker run -p 3000:3000 --env-file backend/.env.local faceoff-brackets

# ---- 1. Build the frontend as static files ----------------------------------
FROM node:24-bookworm-slim AS frontend-build
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./

# Same-origin API calls. Supabase's VITE_* values come from the checked-in
# frontend/.env (publishable, not secrets); pass --build-arg to override.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    FRONTEND_SPA_BUILD=true
RUN npm run build

# ---- 2. Build the backend, bundling the frontend into public/ --------------
FROM node:24-bookworm-slim AS backend-build
WORKDIR /app/backend

# postinstall runs `prisma generate` and scripts/fix-tsc-bin.cjs, so those
# inputs must be present before `npm ci`.
COPY backend/package.json backend/package-lock.json backend/prisma7.config.ts ./
COPY backend/prisma ./prisma
COPY backend/scripts ./scripts
RUN npm ci --no-audit --no-fund

COPY backend/ ./
COPY --from=frontend-build /app/frontend/.vercel/output/static/ ./public/

ENV SERVE_FRONTEND=true \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build \
 && cp -r public .next/standalone/ \
 && cp -r .next/static .next/standalone/.next/

# ---- 3. Runtime --------------------------------------------------------------
FROM node:24-bookworm-slim AS runner
WORKDIR /app

# Frontend and API share one origin here, so the anonymous-voter cookie is
# host-only (empty Domain) rather than scoped to a shared parent domain
# (spec §6).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    VOTER_COOKIE_DOMAIN=""

COPY --from=backend-build --chown=node:node /app/backend/.next/standalone ./

USER node
EXPOSE 3000
CMD ["node", "server.js"]
