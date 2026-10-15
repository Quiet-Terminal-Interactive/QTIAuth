FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN node apps/web/build.ts
RUN --mount=type=cache,id=pnpm,target=/pnpm/store find . -name node_modules -type d -prune -exec rm -rf {} + \
    && pnpm install --frozen-lockfile --prod --offline \
    && rm -rf test coverage .git

FROM node:22-bookworm-slim AS runtime
ARG QTIAUTH_VERSION=dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg tini \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && apt-get purge -y curl gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && groupadd --system --gid 10001 qtiauth && useradd --system --uid 10001 --gid qtiauth --home /app qtiauth \
    && install -d -o qtiauth -g qtiauth -m 0700 /backups
WORKDIR /app
COPY --from=build --chown=root:root /app /app
COPY --chown=root:root deploy/docker/entrypoint.sh /usr/local/bin/entrypoint
COPY --chown=root:root deploy/docker/qtiauth.sh /usr/local/bin/qtiauth
RUN chmod 0555 /usr/local/bin/entrypoint /usr/local/bin/qtiauth
ENV NODE_ENV=production QTIAUTH_CONFIG=/config/qtiauth.yaml QTIAUTH_VERSION=${QTIAUTH_VERSION} NODE_OPTIONS=--enable-source-maps
USER qtiauth
EXPOSE 3000 8080 8081
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint"]
