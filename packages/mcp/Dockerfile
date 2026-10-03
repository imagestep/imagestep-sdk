# Build context is the REPO ROOT (pnpm workspace), not packages/mcp:
#   docker build -f packages/mcp/Dockerfile .
# The hosted MCP server (mcp.imagestep.dev): stateless Streamable HTTP, one ImageStep client per
# request bound to the caller's API key. No local files, no datastore, no session state.
# Node major + Alpine minor pinned, patch floats: every rebuild picks up Node's security releases,
# and a major or distro move is a one-line diff someone chose.
FROM node:24-alpine3.24 AS builder
WORKDIR /repo
RUN npm install -g pnpm@10.34.5
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/mcp/package.json packages/mcp/
COPY sdk/js/package.json sdk/js/
RUN pnpm install --frozen-lockfile --filter @imagestep/mcp... --prod
COPY sdk/js sdk/js
COPY packages/mcp packages/mcp

FROM node:24-alpine3.24
RUN apk add --no-cache tini && \
    command -v tini || (echo "ERROR: tini not found — node would run as PID 1 (imagestep#629)!" && exit 1)
WORKDIR /repo/packages/mcp
COPY --from=builder /repo /repo
USER node
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
# tini, not node, is PID 1 (imagestep#629, as #190 did for processing / render). The kernel does not apply a signal's
# default action to PID 1, so with no handler registered a rollout's SIGTERM was dropped and every pod sat out the full
# 30 s grace until the kubelet's SIGKILL cut the tool calls in flight. The --http branch of bin/imagestep-mcp.js now
# drains on SIGTERM; tini forwards it, and gives node the default action for one that lands before the handler exists.
ENTRYPOINT ["/sbin/tini", "--"]
# --host 0.0.0.0: the server binds loopback unless told otherwise (#470), and the kubelet probes and the tunnel reach
# this container on the pod IP.
CMD ["node", "bin/imagestep-mcp.js", "--http", "--host", "0.0.0.0"]

ARG GITHUB_SHA=unknown
ARG BUILT_AT=unknown
ENV GITHUB_SHA=$GITHUB_SHA \
    BUILT_AT=$BUILT_AT
