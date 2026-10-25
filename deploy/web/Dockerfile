# Frink web mode: the official Linux release with its UI served to browsers.
#
# The official .deb supplies Electron, native modules and bundled tools. Our web-mode build
# (`out/`, from `bun run build`) replaces the app code: Electron loads `resources/app/` (a folder)
# ahead of `resources/app.asar`, and that folder's node_modules resolve to the official ones.
#
# Electron still needs a display to start on Linux (the headless Ozone backend crashes), so it
# runs under Xvfb, an in-memory X server. Nothing on that display is ever shown or streamed;
# people use the UI through their own browser over HTTP(S).
#
# Build from the repo root:  docker build -f deploy/web/Dockerfile -t frink-web .
FROM ubuntu:24.04

ARG FRINK_VERSION=0.4.0
ARG TARGETARCH
ARG OPENCODE_VERSION=1.19.4
ARG NODE_VERSION=22.20.0
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils dbus gnome-keyring \
    libsecret-1-0 libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libnotify4 xdg-utils \
    xvfb xauth git openssh-client ripgrep tini \
 && curl -fsSL -o /tmp/frink.deb \
    "https://pub-c942ee0fa0a549ef8d66096bd831507b.r2.dev/frink_${FRINK_VERSION}_${TARGETARCH}.deb" \
 && apt-get install -y --no-install-recommends /tmp/frink.deb \
 && rm -f /tmp/frink.deb && rm -rf /var/lib/apt/lists/*

# Node for agent CLIs (OpenCode), kept apart from Electron's own runtime.
RUN case "${TARGETARCH}" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
    | tar -xJ -C /opt && mv "/opt/node-v${NODE_VERSION}-linux-${arch}" /opt/node22 \
 && PATH=/opt/node22/bin:$PATH npm install -g --omit=dev "opencode-ai@${OPENCODE_VERSION}" \
 && /opt/node22/bin/opencode --version

# Swap in the web-mode app. Extract the official archive (its node_modules, including the
# unpacked native ones) to a folder app, then replace only the compiled app code. Electron
# searches resources/app before app.asar; the archive is removed so only one app can load.
RUN cd /opt/Frink/resources \
 && PATH=/opt/node22/bin:$PATH npx -y @electron/asar@3.4.1 extract app.asar app \
 && rm -rf app.asar app.asar.unpacked app/out \
 && test -f app/node_modules/node-pty/build/Release/pty.node
COPY package.json /opt/Frink/resources/app/package.json
COPY out /opt/Frink/resources/app/out

RUN groupadd -o -g 20 frink && useradd -m -u 501 -g 20 -o -s /bin/bash frink \
 && mkdir -p /workspace /home/frink/.config && chown -R frink:frink /workspace /home/frink
COPY deploy/web/entrypoint.sh /usr/local/bin/frink-web
COPY deploy/web/seed-opencode.mjs /usr/local/lib/frink-web/seed-opencode.mjs
RUN chmod 0755 /usr/local/bin/frink-web

# Starts as root only to hand freshly mounted volumes to frink, then drops privileges
# (entrypoint.sh). Run with `--user 501:20` where volumes already belong to frink.
ENV HOME=/home/frink \
    PATH=/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    WS_NO_BUFFER_UTIL=1 \
    FRINK_WEB_PORT=8080 \
    FRINK_WEB_HOST=0.0.0.0 \
    FRINK_WEB_ROOTS=/workspace \
    ELECTRON_DISABLE_SECURITY_WARNINGS=1
WORKDIR /workspace
VOLUME ["/home/frink", "/workspace"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsS "http://127.0.0.1:${FRINK_WEB_PORT}/__frink/health" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/frink-web"]
